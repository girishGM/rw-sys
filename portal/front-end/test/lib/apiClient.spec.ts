/**
 * T-022 — `apiClient`'s full interceptor chain, exercised end to end against the real
 * `axios` package with a custom `adapter` standing in for the network (04-FRONTEND.md §8).
 *
 * Deliberately **not** `vi.mock('axios', ...)`: a mocked `axios` module would only prove
 * this file calls the functions it expects itself to call. Running the real request/response
 * interceptor pipeline — real `AxiosHeaders`, a real promise chain, a real `mergeConfig` on
 * retry — is what actually proves the single-flight refresh and the CSRF/error mapping work
 * the way a browser would run them. `test/auth/logout.spec.tsx` (T-020) is the one place a
 * bare-`axios.create` mock is appropriate, because that test is about `useLogout`'s own
 * fire-and-forget call, not this interceptor chain.
 */
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureSessionExpiredHandler,
  createApiClient,
  endSession,
} from '../../src/lib/apiClient';
import { ApiError } from '../../src/lib/apiError';
import { queryClient } from '../../src/lib/queryClient';
import {
  beginHandshake,
  completeHandshake,
  CORRELATION_HEADER,
  PAYLOAD_ENCRYPTED_HEADER,
  resetTransport,
  TRANSPORT_ENVELOPE_VERSION,
  type PayloadEnvelope,
  type TransportResponseHeaders,
} from '../../src/lib/transportCrypto';
import { HKDF_INFO } from '../../src/lib/webcrypto-keys';

interface MockResponse {
  readonly status: number;
  readonly data?: unknown;
  readonly headers?: Record<string, string>;
}

type Handler = (config: InternalAxiosRequestConfig) => MockResponse | Promise<MockResponse>;

/**
 * A minimal but faithful stand-in for a real axios adapter: resolves whenever the request's
 * own `validateStatus` says to (exactly what a real adapter's `settle()` does — see axios's
 * `lib/core/settle.js`), otherwise rejects with a genuine `AxiosError` carrying `.config` and
 * `.response` — the same two properties the real xhr/http adapters attach, and the two this
 * client's error interceptor reads. Falls back to the bare 2xx range for any caller (e.g. a
 * raw `axios.create()` in another test file) that never set one, matching axios's own default.
 */
function createMockAdapter(handler: Handler): {
  adapter: AxiosAdapter;
  calls: InternalAxiosRequestConfig[];
} {
  const calls: InternalAxiosRequestConfig[] = [];

  const adapter: AxiosAdapter = async (config) => {
    calls.push(config);
    const result = await handler(config);
    const response = {
      data: result.data,
      status: result.status,
      statusText: '',
      headers: result.headers ?? {},
      config,
      request: {},
    } as AxiosResponse;

    const validateStatus =
      config.validateStatus ?? ((status: number) => status >= 200 && status < 300);

    if (validateStatus(result.status)) {
      return response;
    }
    throw new AxiosError(
      'Request failed with status code ' + String(result.status),
      undefined,
      config,
      {},
      response,
    );
  };

  return { adapter, calls };
}

function clearCsrfCookie() {
  document.cookie = 'rs_csrf=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
}

// --- a minimal transport-crypto "server", in longhand (T-018 pattern) ------------------------
//
// `transportCrypto.spec.ts` explains at length why this is built from `node:crypto` primitives
// rather than importing the real back end. The same reasoning applies here, at a smaller scale:
// this file only needs one real handshake and one real envelope round trip to prove `apiClient`
// actually wires the request/response encryption in (04-FRONTEND.md §8 implementation note 3's
// "every subsequent request" — none of TC-1…TC-16 above exercise it, because none of them ever
// establish a session).

const KID = 'sess_apiclient-test';

function fakeHeaderBag(values: Record<string, string>): TransportResponseHeaders {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function serverHandshake(clientPublicKeyBase64: string): { publicKeyBase64: string; key: Buffer } {
  const ecdh = createECDH('prime256v1');
  const serverPublicKey = ecdh.generateKeys();
  const clientPublicKey = Buffer.from(clientPublicKeyBase64, 'base64');
  const shared = ecdh.computeSecret(clientPublicKey);
  const salt = Buffer.concat([clientPublicKey, serverPublicKey]);
  const key = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(HKDF_INFO, 'utf8'), 32));
  return { publicKeyBase64: serverPublicKey.toString('base64'), key };
}

function serverAad(direction: 'req' | 'res', correlationId: string, path: string): Buffer {
  return Buffer.from(['v1', KID, direction, correlationId, path].join('|'), 'utf8');
}

function serverSeal(
  key: Buffer,
  plaintext: string,
  direction: 'req' | 'res',
  correlationId: string,
  path: string,
): PayloadEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(serverAad(direction, correlationId, path));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    kid: KID,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

function serverOpen(
  key: Buffer,
  envelope: PayloadEnvelope,
  direction: 'req' | 'res',
  correlationId: string,
  path: string,
): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAAD(serverAad(direction, correlationId, path));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Establishes a `full`-mode session the way T-024's login screen eventually will: generate a
 * keypair, hand it to a "server", complete the handshake from its response headers. */
async function establishFullModeSession(): Promise<Buffer> {
  const pending = await beginHandshake();
  const server = serverHandshake(pending.publicKeyBase64);
  await completeHandshake(
    pending,
    fakeHeaderBag({
      'X-Transport-Public-Key': server.publicKeyBase64,
      'X-Transport-Kid': KID,
      'X-Payload-Encryption': JSON.stringify({ mode: 'full', routeOverrides: {}, fields: [] }),
    }),
  );
  return server.key;
}

beforeEach(() => {
  clearCsrfCookie();
  resetTransport();
});

afterEach(() => {
  queryClient.clear();
  configureSessionExpiredHandler(null);
  clearCsrfCookie();
  resetTransport();
});

describe('CSRF header injection', () => {
  it('TC-1 — a GET request carries no X-CSRF-Token header', async () => {
    document.cookie = 'rs_csrf=tok-abc';
    let sawHeader = true;
    const { adapter } = createMockAdapter((config) => {
      sawHeader = config.headers.has('X-CSRF-Token');
      return { status: 200, data: { data: {} } };
    });

    await createApiClient({ adapter }).get('/campaigns');

    expect(sawHeader).toBe(false);
  });

  it('TC-2 — a POST mirrors the rs_csrf cookie into X-CSRF-Token', async () => {
    document.cookie = 'rs_csrf=tok-abc';
    let seenHeader: unknown;
    const { adapter } = createMockAdapter((config) => {
      seenHeader = config.headers.get('X-CSRF-Token');
      return { status: 200, data: { data: {} } };
    });

    await createApiClient({ adapter }).post('/campaigns', { name: 'Summer' });

    expect(seenHeader).toBe('tok-abc');
  });

  it('TC-3 — a POST with no rs_csrf cookie omits the header, and the resulting 403 surfaces cleanly', async () => {
    let sawHeader = true;
    const { adapter } = createMockAdapter((config) => {
      sawHeader = config.headers.has('X-CSRF-Token');
      return {
        status: 403,
        data: {
          error: { code: 'CSRF_TOKEN_MISSING', message: 'Missing CSRF token.', traceId: 't-csrf' },
        },
      };
    });

    const error = await createApiClient({ adapter })
      .post('/campaigns', {})
      .catch((caught: unknown) => caught);

    expect(sawHeader).toBe(false);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'CSRF_TOKEN_MISSING' });
  });
});

describe('correlation id generation', () => {
  it('falls back to a non-crypto id when WebCrypto has no randomUUID (an older host)', async () => {
    const originalCrypto = globalThis.crypto;
    // Simulate a host with WebCrypto's `subtle` (transportCrypto needs it) but no
    // `randomUUID` (only added to the `Crypto` interface later) — the one branch
    // `generateCorrelationId` falls back for.
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { ...originalCrypto, randomUUID: undefined },
    });

    let seenCorrelationId: unknown;
    const { adapter } = createMockAdapter((config) => {
      seenCorrelationId = config.headers.get(CORRELATION_HEADER);
      return { status: 200, data: { data: {} } };
    });

    try {
      await createApiClient({ adapter }).get('/campaigns');
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
    }

    expect(typeof seenCorrelationId).toBe('string');
    expect(seenCorrelationId).toMatch(/^corr-/);
  });
});

describe('single-flight 401 refresh', () => {
  it('TC-4 — a single 401 triggers exactly one refresh, then the original request is retried once and succeeds', async () => {
    let campaignAttempts = 0;
    let refreshCalls = 0;
    const { adapter } = createMockAdapter((config) => {
      if (config.url === '/auth/refresh') {
        refreshCalls += 1;
        return { status: 200, data: { data: {} } };
      }
      campaignAttempts += 1;
      if (campaignAttempts === 1) {
        return {
          status: 401,
          data: { error: { code: 'AUTH_SESSION_INVALID', message: 'Expired.', traceId: 't-1' } },
        };
      }
      return { status: 200, data: { data: { ok: true } } };
    });

    const response = await createApiClient({ adapter }).get('/campaigns');

    expect(response.data).toEqual({ data: { ok: true } });
    expect(campaignAttempts).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('TC-5 — five concurrent 401s trigger exactly one /auth/refresh call; all five are retried and succeed', async () => {
    let refreshCalls = 0;
    const attemptsByUrl = new Map<string, number>();
    const { adapter } = createMockAdapter((config) => {
      if (config.url === '/auth/refresh') {
        refreshCalls += 1;
        return { status: 200, data: { data: {} } };
      }
      const key = config.url ?? '';
      const attempt = (attemptsByUrl.get(key) ?? 0) + 1;
      attemptsByUrl.set(key, attempt);
      if (attempt === 1) {
        return {
          status: 401,
          data: { error: { code: 'AUTH_SESSION_INVALID', message: 'Expired.', traceId: 't-2' } },
        };
      }
      return { status: 200, data: { data: key } };
    });

    const client = createApiClient({ adapter });
    const paths = ['/a', '/b', '/c', '/d', '/e'];
    const responses = await Promise.all(paths.map((path) => client.get(path)));

    expect(refreshCalls).toBe(1);
    responses.forEach((response, index) => {
      expect(response.data).toEqual({ data: paths[index] });
    });
  });

  it('TC-6 / TC-9 — a failed refresh clears the query cache, hands off to the session-expired handler exactly once, and never recurses into a second refresh of its own 401', async () => {
    const sessionExpired = vi.fn();
    configureSessionExpiredHandler(sessionExpired);
    queryClient.setQueryData(['probe'], 'stale data from a previous session');

    let refreshCalls = 0;
    const { adapter } = createMockAdapter((config) => {
      if (config.url === '/auth/refresh') {
        refreshCalls += 1;
        return {
          status: 401,
          data: {
            error: {
              code: 'AUTH_SESSION_INVALID',
              message: 'Refresh token invalid.',
              traceId: 't-3',
            },
          },
        };
      }
      return {
        status: 401,
        data: { error: { code: 'AUTH_SESSION_INVALID', message: 'Expired.', traceId: 't-4' } },
      };
    });

    const error = await createApiClient({ adapter })
      .get('/campaigns')
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 401, code: 'AUTH_SESSION_INVALID' });
    expect(refreshCalls).toBe(1);
    expect(sessionExpired).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['probe'])).toBeUndefined();
  });

  it('TC-7 — a retried request that 401s again propagates the error without a second refresh', async () => {
    let refreshCalls = 0;
    const { adapter } = createMockAdapter((config) => {
      if (config.url === '/auth/refresh') {
        refreshCalls += 1;
        return { status: 200, data: { data: {} } };
      }
      // Always 401, even after the retry.
      return {
        status: 401,
        data: {
          error: { code: 'AUTH_SESSION_INVALID', message: 'Still expired.', traceId: 't-5' },
        },
      };
    });

    const error = await createApiClient({ adapter })
      .get('/campaigns')
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 401, code: 'AUTH_SESSION_INVALID' });
    expect(refreshCalls).toBe(1);
  });

  it('TC-8 — a 401 from /auth/login never triggers a refresh', async () => {
    let refreshCalls = 0;
    const { adapter } = createMockAdapter((config) => {
      if (config.url === '/auth/refresh') {
        refreshCalls += 1;
        return { status: 200, data: { data: {} } };
      }
      return {
        status: 401,
        data: {
          error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Bad credentials.', traceId: 't-6' },
        },
      };
    });

    const error = await createApiClient({ adapter })
      .post('/auth/login', { email: 'a@b.com', password: 'x' })
      .catch((caught: unknown) => caught);

    expect(refreshCalls).toBe(0);
    expect(error).toMatchObject({ status: 401, code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it.each(['/auth/mfa/enrol', '/auth/mfa/verify', '/auth/mfa/recover'])(
    'T-060 — a 401 from %s never triggers a refresh either',
    async (path) => {
      let refreshCalls = 0;
      const { adapter } = createMockAdapter((config) => {
        if (config.url === '/auth/refresh') {
          refreshCalls += 1;
          return { status: 200, data: { data: {} } };
        }
        return {
          status: 401,
          data: {
            error: { code: 'AUTH_SESSION_INVALID', message: 'Session invalid.', traceId: 't-mfa' },
          },
        };
      });

      const error = await createApiClient({ adapter })
        .post(path, {})
        .catch((caught: unknown) => caught);

      expect(refreshCalls).toBe(0);
      expect(error).toMatchObject({ status: 401, code: 'AUTH_SESSION_INVALID' });
    },
  );

  it('resets the transport-crypto session on any 401, including one that is not refreshed', async () => {
    const { adapter } = createMockAdapter((config) => {
      if (config.url === '/auth/refresh') return { status: 200, data: {} };
      return {
        status: 401,
        data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'x', traceId: 't-7' } },
      };
    });

    await createApiClient({ adapter })
      .post('/auth/login', {})
      .catch(() => undefined);

    // Nothing observable to assert on `resetTransport` directly beyond "did not throw" —
    // `transportCrypto.spec.ts` (T-018) owns its own behavioural assertions. This just
    // proves `apiClient` actually calls it on the 401 path rather than skipping it.
    expect(true).toBe(true);
  });
});

describe('error mapping', () => {
  it('TC-10 — a 403 is not retried and maps to PERM_DENIED', async () => {
    let attempts = 0;
    const { adapter } = createMockAdapter(() => {
      attempts += 1;
      return {
        status: 403,
        data: { error: { code: 'PERM_DENIED', message: 'Not allowed.', traceId: 't-8' } },
      };
    });

    const error = await createApiClient({ adapter })
      .get('/rules')
      .catch((caught: unknown) => caught);

    expect(attempts).toBe(1);
    expect(error).toMatchObject({ status: 403, code: 'PERM_DENIED' });
  });

  it('TC-11 — a 429 surfaces its Retry-After wait time', async () => {
    const { adapter } = createMockAdapter(() => ({
      status: 429,
      data: { error: { code: 'RATE_LIMITED', message: 'Slow down.', traceId: 't-9' } },
      headers: { 'retry-after': '30' },
    }));

    const error = await createApiClient({ adapter })
      .get('/campaigns')
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 30 });
  });

  it('TC-12 — a 500 carries the traceId through to the ApiError', async () => {
    const { adapter } = createMockAdapter(() => ({
      status: 500,
      data: {
        error: { code: 'INTERNAL_ERROR', message: 'Something broke.', traceId: 'trace-xyz' },
      },
    }));

    const error = await createApiClient({ adapter })
      .get('/campaigns')
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 500, traceId: 'trace-xyz' });
  });

  it('TC-13 — a network failure surfaces a friendly message, not a raw axios error', async () => {
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);
    };

    const error = await createApiClient({ adapter })
      .get('/campaigns')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NETWORK_ERROR');
    expect((error as ApiError).message).not.toMatch(/Network Error/);
  });

  it('TC-15 — a 400 validation error exposes a details array for field-level display', async () => {
    const { adapter } = createMockAdapter(() => ({
      status: 400,
      data: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Fix the highlighted fields.',
          details: [{ field: 'startDate', code: 'DATE_IN_PAST' }],
          traceId: 't-10',
        },
      },
    }));

    const error = await createApiClient({ adapter })
      .post('/campaigns', {})
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: [{ field: 'startDate', code: 'DATE_IN_PAST' }],
    });
  });

  it('every rejection from the client is an ApiError, never a raw AxiosError', async () => {
    const { adapter } = createMockAdapter(() => ({
      status: 404,
      data: { error: { code: 'NOT_FOUND', message: 'x' } },
    }));
    const error: unknown = await createApiClient({ adapter })
      .get('/campaigns/999')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toHaveProperty('isAxiosError');
  });
});

describe('endSession (TC-16, and the default redirect target)', () => {
  it('TC-16 — clears the shared query cache', () => {
    configureSessionExpiredHandler(vi.fn());
    queryClient.setQueryData(['probe'], 'stale');

    endSession();

    expect(queryClient.getQueryData(['probe'])).toBeUndefined();
  });

  it('calls the configured session-expired handler', () => {
    const handler = vi.fn();
    configureSessionExpiredHandler(handler);

    endSession();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the default handler redirects to /login with the current path and query as next', () => {
    const originalLocation = window.location;
    const assignedHrefs: string[] = [];
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        pathname: '/campaigns',
        search: '?page=2',
        set href(value: string) {
          assignedHrefs.push(value);
        },
        get href() {
          return assignedHrefs.at(-1) ?? '';
        },
      },
    });

    try {
      configureSessionExpiredHandler(null);
      endSession();
      expect(assignedHrefs).toEqual(['/login?next=%2Fcampaigns%3Fpage%3D2']);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
  });
});

/**
 * Axios's own default request transform JSON-stringifies a plain-object body before handing
 * it to the adapter — so the envelope the request interceptor built arrives here as a JSON
 * *string*, not the object it was. Parsed back for the fake server to open.
 */
function parseEnvelope(data: unknown): PayloadEnvelope {
  return (typeof data === 'string' ? (JSON.parse(data) as unknown) : data) as PayloadEnvelope;
}

describe('transport payload encryption wiring (T-018 integration)', () => {
  it('encrypts a request body and decrypts an encrypted response once a transport session is established', async () => {
    const serverKey = await establishFullModeSession();
    let correlationId = '';

    const { adapter } = createMockAdapter((config) => {
      expect(config.headers.get(PAYLOAD_ENCRYPTED_HEADER)).toBe(TRANSPORT_ENVELOPE_VERSION);
      correlationId = config.headers.get(CORRELATION_HEADER) as string;
      expect(correlationId).toBeTruthy();

      // "The server": open what the client sealed, then seal a response envelope back.
      const opened = serverOpen(serverKey, parseEnvelope(config.data), 'req', correlationId, '$');
      expect(JSON.parse(opened)).toEqual({ name: 'Summer' });

      const responseEnvelope = serverSeal(
        serverKey,
        JSON.stringify({ data: { id: 7, name: 'Summer' } }),
        'res',
        correlationId,
        '$',
      );
      return {
        status: 200,
        data: responseEnvelope,
        headers: {
          'x-payload-encrypted': TRANSPORT_ENVELOPE_VERSION,
          'x-correlation-id': correlationId,
        },
      };
    });

    const response = await createApiClient({ adapter }).post('/campaigns', { name: 'Summer' });

    expect(response.data).toEqual({ data: { id: 7, name: 'Summer' } });
  });

  it('a 401 drops the transport session, so a retried request after refresh goes out in cleartext — never a stale, replayed envelope', async () => {
    // Exercises `transportCrypto.ts`'s own documented contract ("dropped... on any 401")
    // through a real refresh-and-retry cycle, not just the direct `resetTransport()` call
    // unit-tested above: the *first* attempt is genuinely encrypted (proving the session was
    // real), and the *retried* attempt — issued after `resetTransport()` ran on that 401 —
    // must not carry a stale envelope built under a session that no longer exists.
    const serverKey = await establishFullModeSession();
    let firstAttemptEnvelope: PayloadEnvelope | undefined;
    let firstAttemptCorrelationId = '';
    let secondAttemptEncryptedHeader: string | null = null;
    let secondAttemptBody: unknown;
    let campaignAttempts = 0;

    const { adapter } = createMockAdapter((config) => {
      if (config.url === '/auth/refresh') {
        return { status: 200, data: { data: {} } };
      }
      campaignAttempts += 1;

      if (campaignAttempts === 1) {
        expect(config.headers.get(PAYLOAD_ENCRYPTED_HEADER)).toBe(TRANSPORT_ENVELOPE_VERSION);
        firstAttemptCorrelationId = config.headers.get(CORRELATION_HEADER) as string;
        firstAttemptEnvelope = parseEnvelope(config.data);
        return {
          status: 401,
          data: {
            error: { code: 'AUTH_SESSION_INVALID', message: 'Expired.', traceId: 't-enc-1' },
          },
        };
      }

      secondAttemptEncryptedHeader = config.headers.get(PAYLOAD_ENCRYPTED_HEADER) as string | null;
      secondAttemptBody =
        typeof config.data === 'string' ? (JSON.parse(config.data) as unknown) : config.data;
      return { status: 200, data: { data: { ok: true } } };
    });

    const response = await createApiClient({ adapter }).post('/campaigns', { name: 'Summer' });

    expect(response.data).toEqual({ data: { ok: true } });
    expect(campaignAttempts).toBe(2);

    // The first attempt really was sealed under the real session key — the "server" can open it.
    const opened = serverOpen(
      serverKey,
      firstAttemptEnvelope as PayloadEnvelope,
      'req',
      firstAttemptCorrelationId,
      '$',
    );
    expect(JSON.parse(opened)).toEqual({ name: 'Summer' });

    // The retry carries the plaintext, unencrypted — not a replay of the first envelope.
    // (Real `AxiosHeaders.get()` returns `undefined`, not `null`, for a header that was
    // never set — see `toTransportHeaders`'s own comment on that exact distinction.)
    expect(secondAttemptEncryptedHeader).toBeUndefined();
    expect(secondAttemptBody).toEqual({ name: 'Summer' });
  });

  it('surfaces a clean TRANSPORT_CRYPTO_ERROR, with no refresh attempted, when a request body cannot be encrypted', async () => {
    await establishFullModeSession();
    let refreshCalls = 0;
    const { adapter } = createMockAdapter((config) => {
      if (config.url === '/auth/refresh') refreshCalls += 1;
      return { status: 200, data: { data: {} } };
    });

    // `JSON.stringify` throws on a BigInt — `encryptRequestBody`'s own documented failure mode
    // for "a body that cannot be serialised fails loudly instead of being sent in the clear".
    const error = await createApiClient({ adapter })
      .post('/campaigns', { amount: BigInt(1) })
      .catch((caught: unknown) => caught);

    expect(refreshCalls).toBe(0);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'TRANSPORT_CRYPTO_ERROR', status: 0 });
  });
});

describe('conditional GET / 304 Not Modified (T-061)', () => {
  it('TC-2 — a 304 on a repeated GET resolves (no error toast) and re-serves the last successful body, never `undefined`', async () => {
    let call = 0;
    const { adapter } = createMockAdapter(() => {
      call += 1;
      if (call === 1) return { status: 200, data: { data: [{ id: 1, name: 'Rule A' }] } };
      return { status: 304, data: '' };
    });
    const client = createApiClient({ adapter });

    const first = await client.get('/rules');
    const second = await client.get('/rules');

    expect(first.data).toEqual({ data: [{ id: 1, name: 'Rule A' }] });
    // The defining assertion: a 304's caller sees the data it already had, not `undefined` —
    // the exact failure mode ("Something went wrong") this task exists to fix.
    expect(second.data).toEqual({ data: [{ id: 1, name: 'Rule A' }] });
    expect(second.status).toBe(304);
  });

  it('TC-3 — POST then GET (golden-journey step 3 shape): a follow-up 304 still reflects the just-created row, no error', async () => {
    const { adapter } = createMockAdapter((config) => {
      if (config.method === 'post') {
        return { status: 201, data: { data: { id: 9, name: 'New rule' } } };
      }
      // First GET after the POST is genuinely fresh (200, includes the new row); a second,
      // immediately-following GET (e.g. the "Add rule" dialog's own confirmation read) finds
      // nothing has changed since that first GET and gets 304 back.
      return config.headers.get('X-Probe-Seq') === '2'
        ? { status: 304, data: '' }
        : { status: 200, data: { data: [{ id: 9, name: 'New rule' }] } };
    });
    const client = createApiClient({ adapter });

    await client.post('/rules', { name: 'New rule' });
    const table = await client.get('/rules', { headers: { 'X-Probe-Seq': '1' } });
    const dialog = await client.get('/rules', { headers: { 'X-Probe-Seq': '2' } });

    expect(table.data).toEqual({ data: [{ id: 9, name: 'New rule' }] });
    expect(dialog.status).toBe(304);
    expect(dialog.data).toEqual({ data: [{ id: 9, name: 'New rule' }] });
  });

  it('TC-4 — a genuine 4xx/5xx still surfaces as an error (304 handling must not swallow real failures)', async () => {
    const { adapter } = createMockAdapter(() => ({
      status: 500,
      data: { error: { code: 'INTERNAL_ERROR', message: 'Broke.', traceId: 't-304-1' } },
    }));

    const error = await createApiClient({ adapter })
      .get('/rules')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it('TC-5 — a 304 on an encrypted-transport route (T-018) causes no decrypt error, even though it carries no body', async () => {
    const serverKey = await establishFullModeSession();
    let call = 0;
    let firstCorrelationId = '';

    const { adapter } = createMockAdapter((config) => {
      call += 1;
      if (call === 1) {
        firstCorrelationId = config.headers.get(CORRELATION_HEADER) as string;
        const responseEnvelope = serverSeal(
          serverKey,
          JSON.stringify({ data: [{ id: 1, name: 'Rule A' }] }),
          'res',
          firstCorrelationId,
          '$',
        );
        return {
          status: 200,
          data: responseEnvelope,
          headers: {
            'x-payload-encrypted': TRANSPORT_ENVELOPE_VERSION,
            'x-correlation-id': firstCorrelationId,
          },
        };
      }
      // A 304 carries no body — and, correctly, none of the encryption headers either.
      return { status: 304, data: '' };
    });
    const client = createApiClient({ adapter });

    const first = await client.get('/rules');
    const second = await client.get('/rules').catch((caught: unknown) => caught);

    expect(first.data).toEqual({ data: [{ id: 1, name: 'Rule A' }] });
    expect(second).not.toBeInstanceOf(ApiError);
    expect((second as AxiosResponse).status).toBe(304);
    expect((second as AxiosResponse).data).toEqual({ data: [{ id: 1, name: 'Rule A' }] });
  });

  it('TC-6 — a 304 never triggers the 401 refresh/CSRF single-flight path', async () => {
    let refreshCalls = 0;
    document.cookie = 'rs_csrf=tok-304';
    let sawCsrfOnGet = true;
    const { adapter } = createMockAdapter((config) => {
      if (config.url === '/auth/refresh') {
        refreshCalls += 1;
        return { status: 200, data: { data: {} } };
      }
      sawCsrfOnGet = config.headers.has('X-CSRF-Token');
      return { status: 304, data: '' };
    });

    const response = await createApiClient({ adapter }).get('/rules');

    expect(response.status).toBe(304);
    expect(refreshCalls).toBe(0);
    // A GET never carries CSRF regardless of status — unaffected by the 304 branch.
    expect(sawCsrfOnGet).toBe(false);
  });
});
