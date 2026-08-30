/**
 * T-121 / TC-3 — `FieldApiLookupConfigCrypto` against a real `FieldCryptoService`, built from a
 * real (test-key) `KeyRegistryService` via the same `buildDefaultRegistry()` helper T-016's own
 * suite uses. No mocks: this file proves genuine AES-256-GCM round-trips, AAD binding and the
 * two-phase provisional/rebind sequence, exactly as `reward-connector-config.crypto.spec.ts` does
 * for its own column.
 *
 * The property under test throughout is *"the plaintext credential is not recoverable from what
 * gets stored"* — asserted by searching the stored string for the secret, not by comparing against
 * a hardcoded expected ciphertext (which would be a change-detector, AGENT-PROTOCOL §3: a test
 * that restates a constant cannot fail when the constant is wrong).
 */
import { FieldCryptoService } from '@/common/crypto';
import { DecryptionError } from '@/common/crypto/crypto.errors';
import {
  FIELD_API_LOOKUP_PROVIDERS_TABLE,
  FieldApiLookupConfigCrypto,
  PROVISIONAL_FIELD_API_LOOKUP_PROVIDER_PK,
} from '@/modules/field-value-sources/field-api-lookup-config.crypto';
import { buildDefaultRegistry } from '../crypto/support/keys';

const SECRET = 'sk_live_field_lookup_9f3a';

async function buildCrypto(): Promise<FieldApiLookupConfigCrypto> {
  const fieldCrypto = new FieldCryptoService(await buildDefaultRegistry());
  return new FieldApiLookupConfigCrypto(fieldCrypto);
}

describe('FieldApiLookupConfigCrypto', () => {
  it('TC-3: round-trips a config through encryptForRow/decryptForRow', async () => {
    const crypto = await buildCrypto();
    const stored = crypto.encryptForRow(42, { apiKey: SECRET, headerName: 'X-Api-Key' });

    expect(stored).toEqual(expect.stringMatching(/^v1\./));
    // TC-3 — "ciphertext never equals plaintext in the DB". The secret must not appear anywhere
    // in the stored string, not merely differ from it.
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('X-Api-Key');

    expect(crypto.decryptForRow(42, stored)).toEqual({
      apiKey: SECRET,
      headerName: 'X-Api-Key',
    });
  });

  it('binds the row id as AAD — a ciphertext copied to a different row fails to decrypt', async () => {
    const crypto = await buildCrypto();
    const stored = crypto.encryptForRow(1, { apiKey: SECRET });

    // The security property that makes per-row encryption meaningful: lifting row 1's ciphertext
    // into row 2 does not yield row 1's credential.
    expect(crypto.decryptForRow(2, stored)).toBeNull();
  });

  it('the two-phase provisional → rebind sequence produces a value readable under the real id', async () => {
    const crypto = await buildCrypto();
    const provisional = crypto.encryptForNewRow({ apiKey: SECRET });

    // Not yet readable under a real id — the AAD is still the provisional placeholder. This is
    // why the rebind must happen in the same transaction as the INSERT.
    expect(crypto.decryptForRow(99, provisional)).toBeNull();

    const rebound = crypto.rebindToRow(99, provisional);
    expect(rebound).not.toBe(provisional);
    expect(crypto.decryptForRow(99, rebound)).toEqual({ apiKey: SECRET });
  });

  it('encryptForNewRow/encryptForRow map null and undefined to a SQL NULL, not to encrypted emptiness', async () => {
    const crypto = await buildCrypto();

    // "This provider has no credential" must stay queryable as `auth_config_enc IS NULL` — the
    // state every row seeded by T121_002 is in.
    expect(crypto.encryptForNewRow(null)).toBeNull();
    expect(crypto.encryptForNewRow(undefined)).toBeNull();
    expect(crypto.encryptForRow(1, null)).toBeNull();
    expect(crypto.encryptForRow(1, undefined)).toBeNull();
  });

  it('rebindToRow() passes a null straight through — nothing to rebind is not an error', async () => {
    const crypto = await buildCrypto();
    expect(crypto.rebindToRow(1, null)).toBeNull();
  });

  it('rebindToRow() throws when given a value that is not a provisional ciphertext', async () => {
    const crypto = await buildCrypto();
    expect(() => crypto.rebindToRow(1, 'not-a-ciphertext')).toThrow(
      /rebindToRow\(\) called with a value that is not a provisional/,
    );
  });

  it('decryptForRow() returns null for a NULL column', async () => {
    const crypto = await buildCrypto();
    expect(crypto.decryptForRow(1, null)).toBeNull();
  });

  it('decryptForRow() returns null (never throws) for a value that is not ciphertext at all', async () => {
    const crypto = await buildCrypto();
    expect(crypto.decryptForRow(1, 'PLACEHOLDER — confirm with data owner')).toBeNull();
  });

  it('decryptForRow() returns null (never throws) on a tampered ciphertext', async () => {
    const crypto = await buildCrypto();
    const stored = crypto.encryptForRow(1, { apiKey: SECRET });
    const tampered = `${stored ?? ''}tampered`;

    // Confirms the tamper genuinely reaches DecryptionError territory before decryptForRow's own
    // try/catch swallows it — proving the null return is deliberate handling, not an accident of
    // the value failing some earlier shape check.
    const fieldCrypto = new FieldCryptoService(await buildDefaultRegistry());
    expect(() =>
      fieldCrypto.decrypt(tampered, {
        aad: FieldCryptoService.aadFor(FIELD_API_LOOKUP_PROVIDERS_TABLE, 1),
      }),
    ).toThrow(DecryptionError);

    expect(crypto.decryptForRow(1, tampered)).toBeNull();
  });

  it('two rows with the same credential produce different ciphertexts', async () => {
    const crypto = await buildCrypto();
    const a = crypto.encryptForRow(1, { apiKey: SECRET });
    const b = crypto.encryptForRow(2, { apiKey: SECRET });

    // Distinct AAD and a fresh IV per call: equal plaintexts must not be linkable by comparing
    // stored values across rows.
    expect(a).not.toEqual(b);
  });

  it('the provisional AAD is a non-numeric sentinel that cannot collide with a real row id', () => {
    // A numeric-looking placeholder could collide with a genuine identity value and silently make
    // a provisional ciphertext readable as though it were bound to a real row.
    expect(PROVISIONAL_FIELD_API_LOOKUP_PROVIDER_PK).toBe('#new-field-api-lookup-provider');
    expect(Number.isNaN(Number(PROVISIONAL_FIELD_API_LOOKUP_PROVIDER_PK))).toBe(true);
  });
});
