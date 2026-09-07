/**
 * T-RR-005. Unit tests against a real `EncryptionService` instance (pure, in-memory key
 * material — no DB, no env) — `LogRedactorService` is deliberately DB-free (see its own header),
 * so there is nothing here to stub beyond the encryption primitive itself.
 */
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';

const encryption = new EncryptionService({
  aesKey: Buffer.alloc(32, 1),
  hmacKey: Buffer.alloc(32, 2),
});

describe('LogRedactorService', () => {
  const redactor = new LogRedactorService(encryption);

  // TC-8
  it('redactCustomerId returns the hash, never a substring of the raw plaintext', () => {
    const customerId = 'CUST-00042-abc-super-secret';
    const redacted = redactor.redactCustomerId(customerId);

    expect(redacted).not.toContain(customerId);
    expect(redacted).toBe(encryption.hash(customerId));
  });

  it('redactCustomerId is deterministic for the same customerId (matches customer_id_hash lookup semantics)', () => {
    expect(redactor.redactCustomerId('CUST-00042-abc')).toBe(
      redactor.redactCustomerId('CUST-00042-abc'),
    );
  });

  it('redactCustomerId returns different values for different customerId inputs', () => {
    expect(redactor.redactCustomerId('CUST-00042-abc')).not.toBe(
      redactor.redactCustomerId('CUST-00099-xyz'),
    );
  });

  // R8: never the raw value, for a range of realistic-looking ids, not just one hardcoded sample.
  it.each(['CUST-00001', 'a@b.com-linked-id-77', '000000000123456789'])(
    'never echoes %s verbatim in its redacted output',
    (customerId) => {
      expect(redactor.redactCustomerId(customerId)).not.toContain(customerId);
    },
  );
});
