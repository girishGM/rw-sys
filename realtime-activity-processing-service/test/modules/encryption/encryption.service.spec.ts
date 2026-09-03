/**
 * T-RAP-012. Pure, synchronous unit tests — no network, no DB. TC-7's own "process exits
 * non-zero at boot" observable is proven separately, in a real spawned subprocess
 * (`boot.e2e-spec.ts`), since a mocked `process.exit` here would only prove this function *calls*
 * a spy, not that a real process actually terminates non-zero.
 */
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';

const AES_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 2).toString('base64');

describe('loadEncryptionKeyMaterial', () => {
  const ENV_KEYS = ['FIELD_ENCRYPTION_AES_KEY', 'FIELD_ENCRYPTION_HMAC_KEY'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('loads valid base64 32-byte AES and HMAC keys', () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;

    const material = loadEncryptionKeyMaterial();
    expect(material.aesKey).toHaveLength(32);
    expect(material.hmacKey.length).toBeGreaterThanOrEqual(32);
  });

  // TC-7 (the in-process half — the real "exits non-zero" half is boot.e2e-spec.ts).
  it('throws naming FIELD_ENCRYPTION_AES_KEY when it is unset', () => {
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
    expect(() => loadEncryptionKeyMaterial()).toThrow(/FIELD_ENCRYPTION_AES_KEY/);
  });

  it('throws naming FIELD_ENCRYPTION_HMAC_KEY when it is unset', () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    expect(() => loadEncryptionKeyMaterial()).toThrow(/FIELD_ENCRYPTION_HMAC_KEY/);
  });

  it('rejects an AES key that does not decode to exactly 32 bytes', () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = Buffer.alloc(16, 1).toString('base64');
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
    expect(() => loadEncryptionKeyMaterial()).toThrow(/32 bytes/);
  });

  it('rejects an HMAC key shorter than 32 bytes', () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = Buffer.alloc(8, 2).toString('base64');
    expect(() => loadEncryptionKeyMaterial()).toThrow(/at least 32 bytes/);
  });

  it('rejects reusing the AES key as the HMAC key', () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = AES_KEY_B64;
    expect(() => loadEncryptionKeyMaterial()).toThrow(/must not be the same value/);
  });
});

describe('EncryptionService', () => {
  const service = new EncryptionService({
    aesKey: Buffer.alloc(32, 1),
    hmacKey: Buffer.alloc(32, 2),
  });

  // TC-1
  it('round-trips a sample customerId exactly through encrypt/decrypt', () => {
    const plaintext = 'CUST-00042-abc';
    const encrypted = service.encrypt(plaintext);
    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext for two encrypt calls of the same plaintext (fresh IV each time)', () => {
    const plaintext = 'CUST-00042-abc';
    expect(service.encrypt(plaintext)).not.toBe(service.encrypt(plaintext));
  });

  it('rejects a tampered ciphertext rather than silently returning corrupted plaintext', () => {
    const encoded = service.encrypt('CUST-00042-abc');
    const raw = Buffer.from(encoded, 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a bit inside the auth tag
    const tampered = raw.toString('base64');
    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('rejects decryption under the wrong AES key', () => {
    const encoded = service.encrypt('CUST-00042-abc');
    const otherService = new EncryptionService({
      aesKey: Buffer.alloc(32, 9),
      hmacKey: Buffer.alloc(32, 2),
    });
    expect(() => otherService.decrypt(encoded)).toThrow();
  });

  // TC-2
  it('hashes the same customerId twice to the identical value', () => {
    expect(service.hash('CUST-00042-abc')).toBe(service.hash('CUST-00042-abc'));
  });

  // TC-3
  it('hashes two different customerId values to different results', () => {
    expect(service.hash('CUST-00042-abc')).not.toBe(service.hash('CUST-00099-xyz'));
  });

  it('produces a lowercase-hex, 64-character SHA-256 digest', () => {
    expect(service.hash('CUST-00042-abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});
