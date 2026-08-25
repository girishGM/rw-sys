/**
 * T-047 — `InternalTlsListener` over a **real** mutual-TLS socket, with stub handlers.
 *
 * ### Why this suite exists separately from `grpc.e2e-spec.ts`
 *
 * The e2e suite proves the *service* behaves correctly; this one proves the *transport* does, and
 * the two fail in very different ways. A transport that never sends its status trailer does not
 * return a wrong answer — it returns **no** answer, and every test above it hangs until its
 * deadline. That is exactly what happened during T-047's implementation: `sendTrailers()` was
 * called directly, Node threw `ERR_HTTP2_TRAILERS_NOT_READY` (it requires
 * `respond(headers, { waitForTrailers: true })` and the `wantTrailers` event), the throw escaped
 * from the `catch` block that was reporting a *failed* RPC, and the client sat on an open stream.
 * The e2e suite reported that as a ten-minute timeout with no diagnostic; this suite reports it in
 * under a second, which is the difference between a bug that is found and one that is guessed at.
 *
 * So every assertion here is about the envelope rather than the payload: a status trailer arrives,
 * it carries the right code, and **the stream closes**. `jest.setTimeout` is deliberately short —
 * a hang must fail, not stall.
 */
import { constants, type ClientHttp2Session } from 'node:http2';
import { GrpcError, GrpcStatus } from '@/grpc/grpc.errors';
import { InternalTlsListener, frameMessage } from '@/grpc/wire/grpc-http2.server';
import { createTestPki, type TestPki } from './support/test-pki';
import { openSession, postJson, serverStream, unary } from './support/grpc-test-client';

jest.setTimeout(20_000);

const SERVICE = 'rewardportal.config.v1.CampaignConfigService';
const TTL_HEADER = 'x-config-ttl-seconds';

let pki: TestPki;
let listener: InternalTlsListener;
let port: number;
const errors: string[] = [];
/** How many times a handler actually ran — the proof that a refused connection reached none. */
let echoCalls = 0;

/** Resolves when `emit` has been called `count` times, or rejects on a short deadline. */
function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > 5_000) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Held in an object rather than in two `let`s so control-flow narrowing does not decide that
 * `emit` is `null` for the rest of the test after the reset assignment. */
const watchState: { emit: ((message: Buffer) => void) | null; aborted: boolean } = {
  emit: null,
  aborted: false,
};

/** Kept in a function so the `= null` assignment does not narrow `emit` to `never` for the rest of
 * the enclosing test body. */
function resetWatchState(): void {
  watchState.emit = null;
  watchState.aborted = false;
}

beforeAll(async () => {
  pki = createTestPki();
  listener = new InternalTlsListener(SERVICE, {
    port: 0,
    host: '127.0.0.1',
    key: pki.server.key,
    cert: pki.server.cert,
    ca: pki.ca,
    responseHeaders: { [TTL_HEADER]: '300' },
    onError: (message, error) => errors.push(`${message}: ${String(error)}`),
  });

  listener.registerUnary('Echo', async (_context, request) => {
    echoCalls += 1;
    return request;
  });
  listener.registerUnary('Denied', async () => {
    throw new GrpcError(GrpcStatus.PERMISSION_DENIED, 'not granted section RULES');
  });
  listener.registerUnary('Boom', async () => {
    throw new Error('a secret detail that must not cross the wire');
  });
  listener.registerStream('Watch', async (_context, _request, emit, signal) => {
    watchState.emit = emit;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        watchState.aborted = true;
        resolve();
      };
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    });
  });
  listener.registerRest(async (_context, method, body) => {
    if (method !== 'POST') return { status: 405, body: { error: { code: 'NOT_FOUND' } } };
    return { status: 200, body: { data: JSON.parse(body.toString('utf8')) } };
  });

  await listener.listen();
  port = listener.address();
});

afterAll(async () => {
  await listener?.close();
  pki?.destroy();
});

async function trustedSession(): Promise<ClientHttp2Session> {
  const identity = pki.client('txn-runtime.internal');
  return openSession({ port, ca: pki.ca, cert: identity.cert, key: identity.key });
}

describe('the handshake is genuinely mutual (TC-9, TC-10)', () => {
  it('refuses a client that presents no certificate', async () => {
    await expect(openSession({ port, ca: pki.ca })).rejects.toThrow();
  });

  it('refuses a certificate signed by an untrusted CA', async () => {
    const foreign = pki.foreignClient('txn-runtime.internal');
    await expect(
      openSession({ port, ca: pki.ca, cert: foreign.cert, key: foreign.key }),
    ).rejects.toThrow();
  });

  it('accepts a certificate signed by the configured CA', async () => {
    const session = await trustedSession();
    expect(session.closed).toBe(false);
    session.close();
  });
});

describe('every unary call terminates with a status trailer', () => {
  let session: ClientHttp2Session;
  beforeAll(async () => {
    session = await trustedSession();
  });
  afterAll(() => session.close());

  it('a successful call returns OK, the payload and the documented TTL header', async () => {
    const result = await unary(session, `/${SERVICE}/Echo`, Buffer.from('hello', 'utf8'));
    expect(result.httpStatus).toBe(200);
    expect(result.grpcStatus).toBe(GrpcStatus.OK);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].toString('utf8')).toBe('hello');
    expect(result.headers[TTL_HEADER]).toBe('300');
  });

  it('a failed call is HTTP 200 with the status in the trailer, not an HTTP error', async () => {
    // The regression this whole file exists for: before the `waitForTrailers` fix this call never
    // completed at all. A conformant client reads `grpc-status`; an HTTP 403 would surface as
    // UNKNOWN and lose the PERMISSION_DENIED 09-INTEGRATION.md §7 requires the caller to see.
    const result = await unary(session, `/${SERVICE}/Denied`, Buffer.alloc(0));
    expect(result.httpStatus).toBe(200);
    expect(result.grpcStatus).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(result.grpcMessage).toBe('not granted section RULES');
    expect(result.messages).toHaveLength(0);
  });

  it('an unexpected throw is INTERNAL and leaks no detail to the peer', async () => {
    const result = await unary(session, `/${SERVICE}/Boom`, Buffer.alloc(0));
    expect(result.grpcStatus).toBe(GrpcStatus.INTERNAL);
    expect(result.grpcMessage).toBe('internal error');
    expect(result.grpcMessage).not.toContain('secret detail');
    expect(errors.some((entry) => entry.includes('secret detail'))).toBe(true);
  });

  it('an unknown method is NOT_FOUND rather than a hung stream', async () => {
    const result = await unary(session, `/${SERVICE}/NoSuchMethod`, Buffer.alloc(0));
    expect(result.grpcStatus).toBe(GrpcStatus.NOT_FOUND);
    expect(result.grpcMessage).toContain('NoSuchMethod');
  });

  it('a compressed frame is refused rather than mis-parsed', async () => {
    const compressed = Buffer.concat([Buffer.from([1, 0, 0, 0, 1]), Buffer.from([0x41])]);
    const result = await new Promise<number>((resolve, reject) => {
      const stream = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/${SERVICE}/Echo`,
        [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc+proto',
        te: 'trailers',
      });
      let status = -1;
      stream.on('trailers', (trailers) => {
        status = Number((trailers as Record<string, string>)['grpc-status'] ?? -1);
      });
      stream.on('data', () => undefined);
      stream.on('error', reject);
      stream.on('close', () => resolve(status));
      stream.end(compressed);
    });
    expect(result).toBe(GrpcStatus.INVALID_ARGUMENT);
  });
});

describe('the server stream delivers messages and aborts when the client goes away', () => {
  it('emits to the client and signals abort on close (TC-25)', async () => {
    const session = await trustedSession();
    resetWatchState();

    const handle = serverStream(session, `/${SERVICE}/Watch`, Buffer.alloc(0));
    await waitFor(() => watchState.emit !== null, 'the handler to be invoked');

    watchState.emit?.(Buffer.from('event-1', 'utf8'));
    await waitFor(() => handle.messages.length === 1, 'the first event to arrive');
    expect(handle.messages[0].toString('utf8')).toBe('event-1');

    handle.close();
    await handle.done;
    await waitFor(() => watchState.aborted, 'the handler to observe the abort');
    session.close();
  });
});

describe('the §7a REST callback shares the socket and therefore the trust domain', () => {
  it('answers JSON over the same mTLS session', async () => {
    const session = await trustedSession();
    const response = await postJson(session, '/internal/v1/campaigns/1/budget-breach', {
      capId: 7,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { capId: 7 } });
    session.close();
  });

  it('is unreachable without a client certificate — the same handshake as gRPC (TC-38)', async () => {
    await expect(openSession({ port, ca: pki.ca })).rejects.toThrow();
  });
});

describe('frameMessage round-trips through a real socket', () => {
  it('handles a message large enough to span several DATA chunks', async () => {
    const session = await trustedSession();
    const payload = Buffer.alloc(200_000, 0x7a);
    const result = await unary(session, `/${SERVICE}/Echo`, payload);
    expect(result.grpcStatus).toBe(GrpcStatus.OK);
    expect(result.messages[0].length).toBe(payload.length);
    expect(result.messages[0].equals(payload)).toBe(true);
    session.close();
  });

  it('frames a zero-length message as a header with no body', () => {
    expect(frameMessage(Buffer.alloc(0))).toEqual(Buffer.from([0, 0, 0, 0, 0]));
  });
});

describe('nothing reaches a handler without the handshake', () => {
  it('invokes no handler at all for a connection the TLS layer refused', async () => {
    const callsBefore = echoCalls;
    const errorsBefore = errors.length;

    // A client with no certificate. Node's TLS 1.3 client completes its own half of the handshake
    // before the server has validated it, so the session may briefly appear open — `openSession`
    // pings to settle that question, and the ping is what fails.
    await expect(openSession({ port, ca: pki.ca })).rejects.toThrow();

    expect(echoCalls).toBe(callsBefore);
    // The listener may record a TLS-level notice; it must never record a handler failure, because
    // no handler ran.
    expect(errors.slice(errorsBefore).some((entry) => entry.includes('handler failed'))).toBe(
      false,
    );
  });
});
