/**
 * T-018 — the ECDH handshake (TC-1), and every path by which it can decline to produce a key.
 *
 * The interoperability half of TC-1 — "both sides derive the same key" — is asserted twice, from
 * two directions:
 *
 *  - here, against a second independent `createECDH` acting as the browser, which proves the
 *    derivation is symmetric and that the HKDF inputs are ordered the same way on both sides;
 *  - in `front-end/test/lib/transportCrypto.spec.ts`, against the **real WebCrypto**
 *    implementation the browser will use, which proves the two codebases agree.
 *
 * Neither alone is sufficient: this one would pass if both sides of *this* file were wrong in the
 * same way, and that one would pass if the browser library were self-consistent but off-spec.
 */
import { createECDH } from 'node:crypto';
import { FieldCryptoService } from '@/common/crypto';
import {
  deriveTransportKey,
  decodePoint,
  HandshakeService,
  HKDF_INFO,
  TRANSPORT_KEY_BYTES,
  UNCOMPRESSED_POINT_BYTES,
} from '@/common/transport-crypto/handshake.service';
import { sessionKid } from '@/common/transport-crypto/transport-crypto.constants';
import { buildHandshake, FakeTransportKeyStore, SESSION_ID } from './support/harness';
import type { HandshakeHarness } from './support/harness';

/** A stand-in browser: generates a P-256 keypair and derives the key the same way the SPA will. */
function browser(): { publicKeyBase64: string; derive: (serverPublicKeyBase64: string) => Buffer } {
  const ecdh = createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  return {
    publicKeyBase64: publicKey.toString('base64'),
    derive: (serverPublicKeyBase64) => {
      const serverPublicKey = Buffer.from(serverPublicKeyBase64, 'base64');
      return deriveTransportKey(ecdh.computeSecret(serverPublicKey), publicKey, serverPublicKey);
    },
  };
}

describe('HandshakeService.establish', () => {
  let harness: HandshakeHarness;

  beforeEach(async () => {
    harness = await buildHandshake();
  });

  it('TC-1 — both sides derive the same key', async () => {
    const client = browser();

    const result = await harness.handshake.establish(SESSION_ID, client.publicKeyBase64);
    expect(result).not.toBeNull();

    const serverSide = await harness.handshake.keyForSession(SESSION_ID);
    const clientSide = client.derive(result!.serverPublicKey);

    expect(serverSide).not.toBeNull();
    expect(serverSide!.equals(clientSide)).toBe(true);
    expect(serverSide).toHaveLength(TRANSPORT_KEY_BYTES);
  });

  it('returns the kid the client must stamp into every envelope', async () => {
    const result = await harness.handshake.establish(SESSION_ID, browser().publicKeyBase64);
    expect(result!.kid).toBe(sessionKid(SESSION_ID));
  });

  it('stores the key encrypted, never in the clear', async () => {
    const client = browser();
    const result = await harness.handshake.establish(SESSION_ID, client.publicKeyBase64);

    const stored = harness.store.keys.get(SESSION_ID)!;
    const derived = client.derive(result!.serverPublicKey);

    // A T-016 envelope, not key bytes — the property `ck_portal_sessions_transport_key_enc`
    // enforces at the database level (T018_001).
    expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]{1,40}\./);
    expect(stored).not.toContain(derived.toString('base64'));
    expect(Buffer.from(stored, 'base64').equals(derived)).toBe(false);
  });

  it('binds the stored key to its own session row, so it cannot be moved to another', async () => {
    await harness.handshake.establish(SESSION_ID, browser().publicKeyBase64);
    const stolen = harness.store.keys.get(SESSION_ID)!;

    // Copy one session's ciphertext onto another row — the ciphertext-swap attack §4 closes.
    harness.store.keys.set('11111111-2222-3333-4444-555555555555', stolen);
    expect(
      await harness.handshake.keyForSession('11111111-2222-3333-4444-555555555555'),
    ).toBeNull();
  });

  it('generates a fresh server keypair per handshake', async () => {
    const first = await harness.handshake.establish(SESSION_ID, browser().publicKeyBase64);
    const second = await harness.handshake.establish(SESSION_ID, browser().publicKeyBase64);
    expect(first!.serverPublicKey).not.toBe(second!.serverPublicKey);
  });

  it.each([
    ['no header at all', undefined],
    ['an empty header', ''],
    ['a value that is not base64 of 65 bytes', 'aGVsbG8='],
    [
      'a compressed point',
      Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64)]).toString('base64'),
    ],
    ['65 bytes that are not on the curve', Buffer.alloc(65, 0x04).toString('base64')],
  ])('declines without failing the login: %s', async (_label, offered) => {
    await expect(harness.handshake.establish(SESSION_ID, offered)).resolves.toBeNull();
    expect(harness.store.keys.size).toBe(0);
  });

  it('declines when the session was revoked between issuance and the write', async () => {
    harness.store.inactive.add(SESSION_ID);
    await expect(
      harness.handshake.establish(SESSION_ID, browser().publicKeyBase64),
    ).resolves.toBeNull();
  });

  it('declines — rather than throwing — when the key ring is unusable', async () => {
    // The realistic cause is a deployment with no active `field` key. A login must not 500 on it.
    const store = new FakeTransportKeyStore();
    const broken = new HandshakeService(store, {
      encrypt: () => {
        throw new Error('no active key for purpose field');
      },
    } as unknown as FieldCryptoService);

    await expect(broken.establish(SESSION_ID, browser().publicKeyBase64)).resolves.toBeNull();
  });

  it('declines when the store itself fails', async () => {
    harness.store.failure = new Error('connection terminated');
    await expect(
      harness.handshake.establish(SESSION_ID, browser().publicKeyBase64),
    ).resolves.toBeNull();
  });
});

describe('HandshakeService.keyForSession', () => {
  let harness: HandshakeHarness;

  beforeEach(async () => {
    harness = await buildHandshake();
  });

  it('is null for a session that never handshook', async () => {
    await expect(harness.handshake.keyForSession(SESSION_ID)).resolves.toBeNull();
  });

  it('is null once the session is no longer active (TC-14)', async () => {
    await harness.handshake.establish(SESSION_ID, browser().publicKeyBase64);
    harness.store.inactive.add(SESSION_ID);
    await expect(harness.handshake.keyForSession(SESSION_ID)).resolves.toBeNull();
  });

  it('is null — not a throw — when the stored ciphertext will not decrypt', async () => {
    harness.store.keys.set(
      SESSION_ID,
      'v1.fld_2026_01.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AA==',
    );
    await expect(harness.handshake.keyForSession(SESSION_ID)).resolves.toBeNull();
  });

  it('is null when the stored value decrypts to the wrong number of bytes', async () => {
    harness.store.keys.set(
      SESSION_ID,
      harness.fieldCrypto.encrypt(Buffer.alloc(16, 1).toString('base64'), {
        aad: FieldCryptoService.aadFor('reward_portal.portal_sessions', SESSION_ID),
      }),
    );
    await expect(harness.handshake.keyForSession(SESSION_ID)).resolves.toBeNull();
  });
});

describe('HandshakeService.keyForRequest', () => {
  let harness: HandshakeHarness;

  beforeEach(async () => {
    harness = await buildHandshake();
    await harness.handshake.establish(SESSION_ID, browser().publicKeyBase64);
  });

  it('R3 — reads the session id from the verified token, not from the request body', async () => {
    const request = {
      authUser: { sessionId: SESSION_ID },
      // A body claiming to be another session must have no effect whatsoever.
      body: { sessionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
    } as never;

    await expect(harness.handshake.keyForRequest(request)).resolves.not.toBeNull();
  });

  it('resolves at most once per request', async () => {
    const request = { authUser: { sessionId: SESSION_ID } } as never;
    const spy = jest.spyOn(harness.store, 'find');

    const [first, second] = await Promise.all([
      harness.handshake.keyForRequest(request),
      harness.handshake.keyForRequest(request),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it.each([
    ['no authUser', {}],
    ['an authUser with no sessionId', { authUser: {} }],
    ['a non-string sessionId', { authUser: { sessionId: 7 } }],
    ['an empty sessionId', { authUser: { sessionId: '' } }],
  ])('is null when the request carries %s', async (_label, request) => {
    await expect(harness.handshake.keyForRequest(request as never)).resolves.toBeNull();
  });
});

describe('HandshakeService destroy paths (implementation note 7)', () => {
  it('logout destroys the session key', async () => {
    const harness = await buildHandshake();
    await harness.handshake.establish(SESSION_ID, browser().publicKeyBase64);

    await harness.handshake.destroyForSession(SESSION_ID);

    expect(harness.store.keys.has(SESSION_ID)).toBe(false);
    await expect(harness.handshake.keyForSession(SESSION_ID)).resolves.toBeNull();
  });

  it('logout-all destroys every key the user holds', async () => {
    const harness = await buildHandshake();
    const other = '9c2e5a71-77dd-4a6e-8f0b-1a2b3c4d5e6f';
    harness.store.owners.set(SESSION_ID, 42);
    harness.store.owners.set(other, 42);
    await harness.handshake.establish(SESSION_ID, browser().publicKeyBase64);
    await harness.handshake.establish(other, browser().publicKeyBase64);

    await harness.handshake.destroyForUser(42);

    expect(harness.store.keys.size).toBe(0);
  });
});

describe('decodePoint', () => {
  it('accepts a real uncompressed P-256 point', () => {
    const point = createECDH('prime256v1').generateKeys();
    expect(decodePoint(point.toString('base64'))).toEqual(point);
    expect(point).toHaveLength(UNCOMPRESSED_POINT_BYTES);
  });

  it.each([
    ['a short buffer', Buffer.alloc(32).toString('base64')],
    ['a long buffer', Buffer.alloc(66).toString('base64')],
    [
      'a compressed point',
      Buffer.concat([Buffer.from([0x03]), Buffer.alloc(64)]).toString('base64'),
    ],
    ['garbage', 'this-is-not-base64-of-65-bytes'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(decodePoint(value)).toBeNull();
  });
});

describe('deriveTransportKey', () => {
  it('is deterministic for the same inputs', () => {
    const shared = Buffer.alloc(32, 7);
    const client = Buffer.alloc(65, 1);
    const server = Buffer.alloc(65, 2);
    expect(deriveTransportKey(shared, client, server)).toEqual(
      deriveTransportKey(shared, client, server),
    );
  });

  it('binds the key to the exact pair of public keys (the salt is not decorative)', () => {
    const shared = Buffer.alloc(32, 7);
    const base = deriveTransportKey(shared, Buffer.alloc(65, 1), Buffer.alloc(65, 2));

    expect(deriveTransportKey(shared, Buffer.alloc(65, 9), Buffer.alloc(65, 2))).not.toEqual(base);
    expect(deriveTransportKey(shared, Buffer.alloc(65, 1), Buffer.alloc(65, 9))).not.toEqual(base);
    // Order matters: swapping the two must not produce the same key.
    expect(deriveTransportKey(shared, Buffer.alloc(65, 2), Buffer.alloc(65, 1))).not.toEqual(base);
  });

  it('is not the raw shared secret', () => {
    const shared = Buffer.alloc(32, 7);
    expect(deriveTransportKey(shared, Buffer.alloc(65, 1), Buffer.alloc(65, 2))).not.toEqual(
      shared,
    );
  });

  it('pins the HKDF info string, which both codebases must share verbatim', () => {
    expect(HKDF_INFO).toBe('reward-portal/transport/v1/aes-256-gcm');
  });
});
