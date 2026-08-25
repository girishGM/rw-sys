/**
 * T-018 — the browser transport-crypto library, and its interoperability with the server.
 *
 * ### Why the "server" in this file is written out longhand
 *
 * The back end lives in another workspace, compiled with different module settings, decorators
 * and path aliases; importing it here would be a build fight with no payoff. So the counterparty
 * below is built from `node:crypto` primitives directly — `createECDH`, `hkdfSync`,
 * `createCipheriv('aes-256-gcm')` — which is exactly what
 * `back-end/src/common/transport-crypto/{handshake,transport-envelope}.ts` do.
 *
 * That makes this a genuine interoperability test rather than a self-consistency one: if the
 * browser library drifts from the documented derivation or envelope format, the round trips below
 * fail. The three values both sides must agree on byte for byte — the HKDF `info`, the salt
 * ordering and the AAD string — are additionally pinned as literals, so a drift is reported as
 * "this constant changed" rather than as "decryption failed somewhere".
 *
 * Covers TC-1, TC-2, TC-5, TC-6, TC-7, TC-8, TC-9, TC-10, TC-13, TC-22 and TC-23.
 */
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginHandshake,
  buildAad,
  completeHandshake,
  configureTransportCrypto,
  decryptResponseBody,
  encryptRequestBody,
  isAlwaysCleartext,
  isPayloadEnvelope,
  normalisePath,
  normaliseRouteOverrideKey,
  resetTransport,
  isTransportEstablished,
  transportModeFor,
  TransportCryptoError,
  type PayloadEnvelope,
  type PendingHandshake,
  type TransportResponseHeaders,
} from '../../src/lib/transportCrypto';
import {
  deriveTransportKey,
  generateEcdhKeyPair,
  HKDF_INFO,
  UNCOMPRESSED_POINT_BYTES,
} from '../../src/lib/webcrypto-keys';

/**
 * The `Crypto` the library is driven with.
 *
 * `globalThis.crypto` under vitest's jsdom environment, **not** `webcrypto` imported from
 * `node:crypto` directly. The two are the same implementation, but values created in the test
 * realm and handed to an implementation obtained from the other realm fail some of WebCrypto's
 * `instanceof` argument checks — a test-harness artefact that reports as "importKey: 2nd argument
 * is not a BufferSource" and looks exactly like a bug in the code under test. Using the ambient
 * one is also the more honest test: it is the object a browser would supply.
 */
const nodeCrypto = globalThis.crypto;

const CORRELATION_ID = 'corr-0123456789abcdef';
const KID = 'sess_3f6a1c88-3f2b-4a1e-9d21-6b0a7c9e5d44';

/** Header bag with the `get(name)` contract the library reads, case-insensitively. */
function headers(values: Record<string, string>): TransportResponseHeaders {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

// --- the server, in longhand ------------------------------------------------------------------

/** Mirrors `HandshakeService.establish` + `deriveTransportKey`. */
function serverHandshake(clientPublicKeyBase64: string): { publicKeyBase64: string; key: Buffer } {
  const ecdh = createECDH('prime256v1');
  const serverPublicKey = ecdh.generateKeys();
  const clientPublicKey = Buffer.from(clientPublicKeyBase64, 'base64');
  const shared = ecdh.computeSecret(clientPublicKey);

  // Salt = client || server, in that order. Info = the shared domain-separation string.
  const salt = Buffer.concat([clientPublicKey, serverPublicKey]);
  const key = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(HKDF_INFO, 'utf8'), 32));

  return { publicKeyBase64: serverPublicKey.toString('base64'), key };
}

/** Mirrors `buildAad` in `transport-envelope.ts`. */
function serverAad(direction: 'req' | 'res', correlationId: string, path: string): Buffer {
  return Buffer.from(['v1', KID, direction, correlationId, path].join('|'), 'utf8');
}

/** Mirrors `sealEnvelope`. */
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

/** Mirrors `openEnvelope`. */
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

// --- shared setup ------------------------------------------------------------------------------

interface Established {
  pending: PendingHandshake;
  serverKey: Buffer;
}

async function establish(policy: Record<string, unknown>): Promise<Established> {
  const pending = await beginHandshake();
  const server = serverHandshake(pending.publicKeyBase64);

  const done = await completeHandshake(
    pending,
    headers({
      'X-Transport-Public-Key': server.publicKeyBase64,
      'X-Transport-Kid': KID,
      'X-Payload-Encryption': JSON.stringify(policy),
    }),
  );
  expect(done).toBe(true);

  return { pending, serverKey: server.key };
}

beforeEach(() => {
  configureTransportCrypto(nodeCrypto);
  resetTransport();
});

// --- the handshake -----------------------------------------------------------------------------

describe('handshake', () => {
  it('TC-1 — both sides derive the same key', async () => {
    const pending = await beginHandshake();
    const server = serverHandshake(pending.publicKeyBase64);

    const clientKey = await deriveTransportKey(
      nodeCrypto.subtle,
      pending.privateKey,
      pending.publicKeyBase64,
      server.publicKeyBase64,
    );

    // The client key is non-extractable, so it cannot be compared byte for byte. It is compared
    // *behaviourally* instead, which is the stronger test: the server opens what the client seals.
    const sealed = await nodeCrypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(12),
        additionalData: new Uint8Array(0),
        tagLength: 128,
      },
      clientKey,
      new TextEncoder().encode('interop'),
    );

    const bytes = Buffer.from(sealed);
    const decipher = createDecipheriv('aes-256-gcm', server.key, Buffer.alloc(12), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.alloc(0));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const opened = Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8');

    expect(opened).toBe('interop');
  });

  it('TC-2 — the client private key is non-extractable; exportKey throws', async () => {
    const pair = await generateEcdhKeyPair(nodeCrypto.subtle);

    expect(pair.privateKey.extractable).toBe(false);
    await expect(nodeCrypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
    await expect(nodeCrypto.subtle.exportKey('jwk', pair.privateKey)).rejects.toThrow();
  });

  it('the public key is a 65-byte uncompressed point and is exportable', async () => {
    const pair = await generateEcdhKeyPair(nodeCrypto.subtle);
    const raw = Buffer.from(pair.publicKeyBase64, 'base64');
    expect(raw).toHaveLength(UNCOMPRESSED_POINT_BYTES);
    expect(raw[0]).toBe(0x04);
  });

  it('refuses a public key that is not 65 bytes rather than handing the server something unreadable', async () => {
    // Not reachable through a conforming WebCrypto, which is exactly why it is asserted against a
    // non-conforming one: the guard exists for the day an implementation returns SPKI from
    // `exportKey('raw', …)`, and an unasserted guard is an unknown quantity.
    const wrongLength = {
      generateKey: async () => ({ privateKey: {}, publicKey: {} }),
      exportKey: async () => new Uint8Array(33).buffer,
    } as unknown as SubtleCrypto;

    await expect(generateEcdhKeyPair(wrongLength)).rejects.toThrow(/33-byte P-256 public key/);
  });

  it('TC-23 — the derived session key is a non-extractable CryptoKey', async () => {
    const pending = await beginHandshake();
    const server = serverHandshake(pending.publicKeyBase64);
    const key = await deriveTransportKey(
      nodeCrypto.subtle,
      pending.privateKey,
      pending.publicKeyBase64,
      server.publicKeyBase64,
    );

    expect(key.extractable).toBe(false);
    expect(key.type).toBe('secret');
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(nodeCrypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('TC-23 / R5 — nothing key-shaped is written to localStorage or sessionStorage', async () => {
    // Read through `globalThis` deliberately: the bare identifiers are banned by
    // `no-restricted-globals` in `.eslintrc.cjs`, which is the rule this assertion backs up.
    await establish({ mode: 'full', routeOverrides: {}, fields: [] });
    await encryptRequestBody('POST', '/api/v1/probe', { a: 1 }, CORRELATION_ID);

    expect(globalThis.localStorage.length).toBe(0);
    expect(globalThis.sessionStorage.length).toBe(0);
  });

  it('rejects a server public key that is not an uncompressed P-256 point', async () => {
    const pending = await beginHandshake();
    await expect(
      deriveTransportKey(
        nodeCrypto.subtle,
        pending.privateKey,
        pending.publicKeyBase64,
        Buffer.alloc(65, 0x02).toString('base64'),
      ),
    ).rejects.toThrow(/uncompressed P-256 point/);
  });

  it('degrades rather than throwing when the server completed no handshake', async () => {
    const pending = await beginHandshake();
    await expect(completeHandshake(pending, headers({}))).resolves.toBe(false);
    expect(isTransportEstablished()).toBe(false);
    // The portal continues on TLS alone — the same posture as `mode: off`.
    expect(transportModeFor('POST', '/api/v1/probe')).toBe('off');
  });

  it('falls back to `off` when the server sent no advertisement at all', async () => {
    const pending = await beginHandshake();
    const server = serverHandshake(pending.publicKeyBase64);

    await completeHandshake(
      pending,
      headers({ 'X-Transport-Public-Key': server.publicKeyBase64, 'X-Transport-Kid': KID }),
    );

    expect(isTransportEstablished()).toBe(true);
    // A key exists, so responses can still be *opened*; nothing is *sent* encrypted until the
    // server says what to encrypt. Erring the other way would encrypt routes it treats as clear.
    expect(transportModeFor('POST', '/api/v1/probe')).toBe('off');
  });

  it('generates a fresh keypair per login, so two logins cannot share a key', async () => {
    const first = await beginHandshake();
    const second = await beginHandshake();
    expect(first.publicKeyBase64).not.toBe(second.publicKeyBase64);
  });

  it('resetTransport drops the session (logout, and any 401)', async () => {
    await establish({ mode: 'full', routeOverrides: {}, fields: [] });
    expect(isTransportEstablished()).toBe(true);

    resetTransport();

    expect(isTransportEstablished()).toBe(false);
    expect(transportModeFor('POST', '/api/v1/probe')).toBe('off');
  });
});

// --- the shared constants ----------------------------------------------------------------------

describe('the constants both codebases must share verbatim', () => {
  it('pins the HKDF info string', () => {
    expect(HKDF_INFO).toBe('reward-portal/transport/v1/aes-256-gcm');
  });

  it('pins the AAD format', () => {
    expect(new TextDecoder().decode(buildAad(KID, 'req', CORRELATION_ID, '$'))).toBe(
      `v1|${KID}|req|${CORRELATION_ID}|$`,
    );
  });

  it('pins the route-override key normalisation', () => {
    expect(normaliseRouteOverrideKey('post   /Users')).toBe('POST /users');
    expect(normaliseRouteOverrideKey('/health')).toBe('/health');
  });
});

// --- full mode ---------------------------------------------------------------------------------

describe('mode: full', () => {
  let session: Established;

  beforeEach(async () => {
    session = await establish({ mode: 'full', routeOverrides: {}, fields: [] });
  });

  it('seals the whole body into one envelope the server can open', async () => {
    const { body, encrypted } = await encryptRequestBody(
      'POST',
      '/api/v1/campaigns',
      { name: 'Summer', budget: 1000 },
      CORRELATION_ID,
    );

    expect(encrypted).toBe(true);
    expect(isPayloadEnvelope(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('Summer');

    const opened = serverOpen(
      session.serverKey,
      body as PayloadEnvelope,
      'req',
      CORRELATION_ID,
      '$',
    );
    expect(JSON.parse(opened)).toEqual({ name: 'Summer', budget: 1000 });
  });

  it('TC-5 — opens a whole-body response envelope to the expected JSON', async () => {
    const envelope = serverSeal(
      session.serverKey,
      JSON.stringify({ data: { id: 7, name: 'Summer' } }),
      'res',
      CORRELATION_ID,
      '$',
    );

    const opened = await decryptResponseBody(
      envelope,
      headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
    );

    expect(opened).toEqual({ data: { id: 7, name: 'Summer' } });
  });

  it('TC-13 — a response bound to a different request will not open', async () => {
    const envelope = serverSeal(
      session.serverKey,
      JSON.stringify({ data: 1 }),
      'res',
      'corr-ffffffffffffffff',
      '$',
    );

    await expect(
      decryptResponseBody(
        envelope,
        headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
      ),
    ).rejects.toMatchObject({ reason: 'decrypt_failed' });
  });

  it('a request envelope cannot be replayed as a response', async () => {
    const envelope = serverSeal(
      session.serverKey,
      JSON.stringify({ data: 1 }),
      'req',
      CORRELATION_ID,
      '$',
    );

    await expect(
      decryptResponseBody(
        envelope,
        headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
      ),
    ).rejects.toBeInstanceOf(TransportCryptoError);
  });

  it('TC-22 — a tampered response surfaces a clean error and is not retried', async () => {
    const envelope = serverSeal(
      session.serverKey,
      JSON.stringify({ data: 1 }),
      'res',
      CORRELATION_ID,
      '$',
    );
    const bytes = Buffer.from(envelope.ct, 'base64');
    bytes[0] ^= 0xff;

    const attempt = decryptResponseBody(
      { ...envelope, ct: bytes.toString('base64') },
      headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
    );

    await expect(attempt).rejects.toBeInstanceOf(TransportCryptoError);
    await expect(attempt).rejects.toMatchObject({ reason: 'decrypt_failed' });
    // The message says what happened without echoing the payload, the key or the internals.
    await expect(attempt).rejects.toThrow(/not retried/);
  });

  it('an encrypted response with no correlation id is refused rather than guessed at', async () => {
    const envelope = serverSeal(
      session.serverKey,
      JSON.stringify({ data: 1 }),
      'res',
      CORRELATION_ID,
      '$',
    );

    await expect(
      decryptResponseBody(envelope, headers({ 'X-Payload-Encrypted': 'v1' })),
    ).rejects.toMatchObject({ reason: 'unusable_response' });
  });

  it('an encrypted response arriving after logout is refused with a clear reason', async () => {
    const envelope = serverSeal(
      session.serverKey,
      JSON.stringify({ data: 1 }),
      'res',
      CORRELATION_ID,
      '$',
    );
    resetTransport();

    await expect(
      decryptResponseBody(
        envelope,
        headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
      ),
    ).rejects.toMatchObject({ reason: 'not_established' });
  });

  it('re-throws a TransportCryptoError as itself rather than re-wrapping it', async () => {
    const envelope = serverSeal(
      session.serverKey,
      JSON.stringify({ data: { newPassword: 1 } }),
      'res',
      CORRELATION_ID,
      '$',
    );
    // WebCrypto disappearing mid-session (a page moved out of a secure context) must surface as
    // `not_established` — "log in again" — not as `decrypt_failed`, which would send the client
    // down the wrong recovery path.
    configureTransportCrypto({ subtle: undefined } as unknown as Crypto);

    await expect(
      decryptResponseBody(
        { data: { newPassword: envelope } },
        headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
      ),
    ).rejects.toMatchObject({ reason: 'not_established' });
  });

  it('reports a thrown non-Error without interpolating it into the message', async () => {
    const throwing = {
      subtle: {
        decrypt: () => {
          throw 'a bare string, not an Error';
        },
      },
    } as unknown as Crypto;
    configureTransportCrypto(throwing);

    await expect(
      decryptResponseBody(
        serverSeal(session.serverKey, '{}', 'res', CORRELATION_ID, '$'),
        headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
      ),
    ).rejects.toThrow(/unknown error/);
  });

  it('a cleartext response is passed through untouched', async () => {
    const body = { error: { code: 'PAYLOAD_DECRYPT_FAILED' } };
    // Error responses are never encrypted — see the server's encrypt interceptor. A client that
    // could not read them would be unable to read the very error saying decryption failed.
    await expect(decryptResponseBody(body, headers({}))).resolves.toBe(body);
  });

  it('a body that cannot be serialised fails loudly instead of being sent in the clear', async () => {
    // A `BigInt` is the realistic case — `JSON.stringify` throws on one. Falling back to sending
    // the body unencrypted would be a silent downgrade of the control; the caller gets an error.
    const attempt = encryptRequestBody(
      'POST',
      '/api/v1/campaigns',
      { budget: BigInt(1) },
      CORRELATION_ID,
    );

    await expect(attempt).rejects.toBeInstanceOf(TransportCryptoError);
    await expect(attempt).rejects.toMatchObject({ reason: 'encrypt_failed' });
  });

  it('a body that is not a JSON container is left alone', async () => {
    await expect(
      encryptRequestBody('POST', '/api/v1/probe', 'raw text', CORRELATION_ID),
    ).resolves.toEqual({ body: 'raw text', encrypted: false });
    await expect(
      encryptRequestBody('POST', '/api/v1/probe', undefined, CORRELATION_ID),
    ).resolves.toEqual({ body: undefined, encrypted: false });
  });
});

// --- fields mode -------------------------------------------------------------------------------

describe('mode: fields (TC-6)', () => {
  let session: Established;

  beforeEach(async () => {
    session = await establish({
      mode: 'fields',
      routeOverrides: {},
      fields: ['currentPassword', 'newPassword'],
    });
  });

  it('encrypts only the advertised fields and leaves the rest readable', async () => {
    const { body, encrypted } = await encryptRequestBody(
      'POST',
      '/api/v1/auth/change-password',
      { currentPassword: 'old one', newPassword: 'new one', reason: 'rotation' },
      CORRELATION_ID,
    );

    expect(encrypted).toBe(true);
    const payload = body as Record<string, unknown>;
    expect(payload.reason).toBe('rotation');
    expect(isPayloadEnvelope(payload.currentPassword)).toBe(true);
    expect(isPayloadEnvelope(payload.newPassword)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('old one');

    expect(
      JSON.parse(
        serverOpen(
          session.serverKey,
          payload.newPassword as PayloadEnvelope,
          'req',
          CORRELATION_ID,
          'newPassword',
        ),
      ),
    ).toBe('new one');
  });

  it('binds each field to its own path, so one cannot be moved to another', async () => {
    const { body } = await encryptRequestBody(
      'POST',
      '/api/v1/auth/change-password',
      { currentPassword: 'old one', newPassword: 'new one' },
      CORRELATION_ID,
    );
    const payload = body as Record<string, unknown>;

    expect(() =>
      serverOpen(
        session.serverKey,
        payload.currentPassword as PayloadEnvelope,
        'req',
        CORRELATION_ID,
        'newPassword',
      ),
    ).toThrow();
  });

  it('encrypts advertised fields nested inside arrays, with indexed paths', async () => {
    const { body } = await encryptRequestBody(
      'POST',
      '/api/v1/users',
      { accounts: [{ newPassword: 'first' }, { newPassword: 'second' }] },
      CORRELATION_ID,
    );

    const accounts = (body as { accounts: { newPassword: PayloadEnvelope }[] }).accounts;
    expect(
      JSON.parse(
        serverOpen(
          session.serverKey,
          accounts[1].newPassword,
          'req',
          CORRELATION_ID,
          'accounts.1.newPassword',
        ),
      ),
    ).toBe('second');
  });

  it('leaves a body with no advertised field completely untouched', async () => {
    const body = { name: 'Summer' };
    await expect(
      encryptRequestBody('POST', '/api/v1/campaigns', body, CORRELATION_ID),
    ).resolves.toEqual({ body, encrypted: false });
  });

  it('opens field envelopes in a response', async () => {
    const field = serverSeal(
      session.serverKey,
      JSON.stringify('t3mp-password'),
      'res',
      CORRELATION_ID,
      'data.newPassword',
    );

    const opened = await decryptResponseBody(
      { data: { newPassword: field, id: 7 } },
      headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
    );

    expect(opened).toEqual({ data: { newPassword: 't3mp-password', id: 7 } });
  });

  it('opens field envelopes nested inside a response array', async () => {
    const field = serverSeal(
      session.serverKey,
      JSON.stringify('second'),
      'res',
      CORRELATION_ID,
      'data.1.newPassword',
    );

    const opened = await decryptResponseBody(
      { data: [{ id: 1 }, { newPassword: field }] },
      headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
    );

    expect(opened).toEqual({ data: [{ id: 1 }, { newPassword: 'second' }] });
  });

  it('a non-container response marked encrypted is returned as-is rather than crashing', async () => {
    await expect(
      decryptResponseBody(
        'plain',
        headers({ 'X-Payload-Encrypted': 'v1', 'X-Correlation-Id': CORRELATION_ID }),
      ),
    ).resolves.toBe('plain');
  });
});

// --- modes and routes --------------------------------------------------------------------------

describe('transportModeFor', () => {
  it('TC-7 — `off` disables everything', async () => {
    await establish({ mode: 'off', routeOverrides: {}, fields: ['newPassword'] });
    expect(transportModeFor('POST', '/api/v1/campaigns')).toBe('off');
    await expect(
      encryptRequestBody('POST', '/api/v1/campaigns', { newPassword: 'x' }, CORRELATION_ID),
    ).resolves.toMatchObject({ encrypted: false });
  });

  it('TC-8 — a route override beats the global mode', async () => {
    await establish({
      mode: 'fields',
      routeOverrides: { 'POST /users': 'full' },
      fields: ['newPassword'],
    });

    expect(transportModeFor('POST', '/api/v1/users')).toBe('full');
    expect(transportModeFor('POST', '/api/v1/campaigns')).toBe('fields');
    expect(transportModeFor('GET', '/api/v1/users')).toBe('fields');
  });

  it.each([
    '/api/v1/auth/login',
    '/api/v1/auth/refresh',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
    '/api/v1/health',
    '/api/v1/health/ready',
  ])('TC-9/TC-10 — %s is always cleartext', async (path) => {
    await establish({ mode: 'full', routeOverrides: {}, fields: [] });
    expect(transportModeFor('POST', path)).toBe('off');
    expect(isAlwaysCleartext(path)).toBe(true);
  });

  it('matches the server path normalisation, query string included', () => {
    expect(normalisePath('/api/v1/Campaigns/?page=2')).toBe('/campaigns');
    expect(normalisePath('/api/v1/health#frag')).toBe('/health');
    expect(normalisePath('/api/v1')).toBe('/');
    expect(isAlwaysCleartext('/api/v1/healthcheck')).toBe(false);
  });

  it('falls back to `off` on an unreadable advertisement rather than encrypting blindly', async () => {
    const pending = await beginHandshake();
    const server = serverHandshake(pending.publicKeyBase64);

    for (const advertisement of ['not json', '"a string"', '{"mode":"nonsense"}', 'null']) {
      resetTransport();
      await completeHandshake(
        pending,
        headers({
          'X-Transport-Public-Key': server.publicKeyBase64,
          'X-Transport-Kid': KID,
          'X-Payload-Encryption': advertisement,
        }),
      );
      expect(transportModeFor('POST', '/api/v1/probe')).toBe('off');
    }
  });

  it('drops an override whose value is not a mode, keeping the others', async () => {
    await establish({
      mode: 'fields',
      routeOverrides: { 'POST /users': 'full', 'POST /broken': 'nonsense' },
      fields: [],
    });

    expect(transportModeFor('POST', '/api/v1/users')).toBe('full');
    expect(transportModeFor('POST', '/api/v1/broken')).toBe('fields');
  });

  it('ignores a non-string entry in the advertised field list', async () => {
    await establish({
      mode: 'fields',
      routeOverrides: {},
      fields: ['newPassword', 7, null],
    });

    const { body } = await encryptRequestBody(
      'POST',
      '/api/v1/probe',
      { newPassword: 'x' },
      CORRELATION_ID,
    );
    expect(isPayloadEnvelope((body as Record<string, unknown>).newPassword)).toBe(true);
  });

  it('tolerates an advertisement with no overrides or fields at all', async () => {
    await establish({ mode: 'fields' });
    expect(transportModeFor('POST', '/api/v1/probe')).toBe('fields');
    await expect(
      encryptRequestBody('POST', '/api/v1/probe', { newPassword: 'x' }, CORRELATION_ID),
    ).resolves.toMatchObject({ encrypted: false });
  });
});

// --- environment -------------------------------------------------------------------------------

describe('when WebCrypto is unavailable', () => {
  it('fails with an actionable error rather than a TypeError', async () => {
    configureTransportCrypto({ subtle: undefined } as unknown as Crypto);
    await expect(beginHandshake()).rejects.toMatchObject({ reason: 'not_established' });
    await expect(beginHandshake()).rejects.toThrow(/secure context/);
  });

  it('falls back to the platform Crypto when the override is cleared', async () => {
    configureTransportCrypto(null);
    // The production path: no injection, `globalThis.crypto` used directly. The override exists
    // for tests and for a non-browser host; it must not be *required* for the library to work.
    await expect(beginHandshake()).resolves.toMatchObject({
      publicKeyBase64: expect.any(String) as unknown as string,
    });
  });
});

describe('isPayloadEnvelope', () => {
  it.each([
    [{ kid: 'a', iv: 'b', tag: 'c', ct: 'd' }, true],
    [{ kid: 'a', iv: 'b', tag: 'c' }, false],
    [{ kid: 'a', iv: 'b', tag: 'c', ct: 'd', extra: 1 }, false],
    [{ kid: 'a', iv: 'b', tag: 'c', ct: 7 }, false],
    [[{ kid: 'a', iv: 'b', tag: 'c', ct: 'd' }], false],
    [null, false],
    ['v1.a.b.c.d', false],
  ])('%o → %s', (value, expected) => {
    expect(isPayloadEnvelope(value)).toBe(expected);
  });
});
