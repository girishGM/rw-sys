/**
 * T-RTS-010 — `CustomerIdCryptoService`/`loadCustomerIdCryptoKeyMaterial`. See that file's own header
 * for why this minimal primitive exists inside the ingestion module's own scope rather than a
 * dedicated encryption-module task.
 */
import { randomBytes } from 'node:crypto';
import {
  CustomerIdCryptoService,
  loadCustomerIdCryptoKeyMaterial,
} from '@/modules/ingestion/customer-id-crypto.service';

function realKeyMaterial() {
  return {
    aesKey: randomBytes(32),
    hmacKey: randomBytes(32),
  };
}

describe('T-RTS-010 — CustomerIdCryptoService', () => {
  it('encrypt then decrypt round-trips exactly', () => {
    const service = new CustomerIdCryptoService(realKeyMaterial());
    const plaintext = 'customer-12345';

    const ciphertext = service.encrypt(plaintext);
    expect(service.decrypt(ciphertext)).toBe(plaintext);
  });

  it('two encrypt calls on the identical plaintext produce different ciphertext (fresh IV each time)', () => {
    const service = new CustomerIdCryptoService(realKeyMaterial());
    const plaintext = 'customer-12345';

    const first = service.encrypt(plaintext);
    const second = service.encrypt(plaintext);

    expect(first).not.toBe(second);
  });

  it('hash is deterministic for the same input', () => {
    const service = new CustomerIdCryptoService(realKeyMaterial());
    const plaintext = 'customer-12345';

    expect(service.hash(plaintext)).toBe(service.hash(plaintext));
  });

  it('hash differs for two distinct inputs', () => {
    const service = new CustomerIdCryptoService(realKeyMaterial());

    expect(service.hash('customer-A')).not.toBe(service.hash('customer-B'));
  });

  it('decrypt throws on tampered ciphertext (GCM auth tag check fails)', () => {
    const service = new CustomerIdCryptoService(realKeyMaterial());
    const ciphertext = service.encrypt('customer-12345');
    const raw = Buffer.from(ciphertext, 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a byte inside the auth tag
    const tampered = raw.toString('base64');

    expect(() => service.decrypt(tampered)).toThrow();
  });

  describe('loadCustomerIdCryptoKeyMaterial', () => {
    const originalAes = process.env.FIELD_ENCRYPTION_AES_KEY;
    const originalHmac = process.env.FIELD_ENCRYPTION_HMAC_KEY;

    afterEach(() => {
      if (originalAes === undefined) {
        delete process.env.FIELD_ENCRYPTION_AES_KEY;
      } else {
        process.env.FIELD_ENCRYPTION_AES_KEY = originalAes;
      }
      if (originalHmac === undefined) {
        delete process.env.FIELD_ENCRYPTION_HMAC_KEY;
      } else {
        process.env.FIELD_ENCRYPTION_HMAC_KEY = originalHmac;
      }
    });

    it('throws when FIELD_ENCRYPTION_AES_KEY is missing', () => {
      delete process.env.FIELD_ENCRYPTION_AES_KEY;
      process.env.FIELD_ENCRYPTION_HMAC_KEY = randomBytes(32).toString('base64');

      expect(() => loadCustomerIdCryptoKeyMaterial()).toThrow(/FIELD_ENCRYPTION_AES_KEY/);
    });

    it('throws when FIELD_ENCRYPTION_AES_KEY does not decode to 32 bytes', () => {
      process.env.FIELD_ENCRYPTION_AES_KEY = randomBytes(16).toString('base64');
      process.env.FIELD_ENCRYPTION_HMAC_KEY = randomBytes(32).toString('base64');

      expect(() => loadCustomerIdCryptoKeyMaterial()).toThrow(/32 bytes/);
    });

    it('throws when FIELD_ENCRYPTION_HMAC_KEY is missing', () => {
      process.env.FIELD_ENCRYPTION_AES_KEY = randomBytes(32).toString('base64');
      delete process.env.FIELD_ENCRYPTION_HMAC_KEY;

      expect(() => loadCustomerIdCryptoKeyMaterial()).toThrow(/FIELD_ENCRYPTION_HMAC_KEY/);
    });

    it('throws when the two keys are identical', () => {
      const key = randomBytes(32).toString('base64');
      process.env.FIELD_ENCRYPTION_AES_KEY = key;
      process.env.FIELD_ENCRYPTION_HMAC_KEY = key;

      expect(() => loadCustomerIdCryptoKeyMaterial()).toThrow(/independent key material/);
    });

    it("loads successfully from real env vars (this test run's own .env.local)", () => {
      process.env.FIELD_ENCRYPTION_AES_KEY = originalAes;
      process.env.FIELD_ENCRYPTION_HMAC_KEY = originalHmac;

      const material = loadCustomerIdCryptoKeyMaterial();
      expect(material.aesKey).toHaveLength(32);
      expect(material.hmacKey.length).toBeGreaterThanOrEqual(32);
    });
  });
});
