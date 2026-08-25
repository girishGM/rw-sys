/**
 * T-032 — `RewardConnectorConfigCrypto` against a real `FieldCryptoService`, built from a real
 * (test-key) `KeyRegistryService` — the same `buildDefaultRegistry()` helper T-016's own suite
 * uses (`test/crypto/support/keys.ts`), reused read-only here (no DB, no live environment) so
 * this file proves genuine AES-256-GCM round-trips, AAD binding and the two-phase provisional/
 * rebind sequence, not a mocked stand-in.
 */
import { FieldCryptoService } from '@/common/crypto';
import { DecryptionError } from '@/common/crypto/crypto.errors';
import {
  PROVISIONAL_REWARD_SYSTEM_PK,
  REWARD_SYSTEMS_TABLE,
  RewardConnectorConfigCrypto,
} from '@/modules/rewards/reward-connector-config.crypto';
import { buildDefaultRegistry } from '../crypto/support/keys';

async function buildCrypto(): Promise<RewardConnectorConfigCrypto> {
  const fieldCrypto = new FieldCryptoService(await buildDefaultRegistry());
  return new RewardConnectorConfigCrypto(fieldCrypto);
}

describe('RewardConnectorConfigCrypto', () => {
  it('round-trips a config through encryptForRow/decryptForRow', async () => {
    const crypto = await buildCrypto();
    const stored = crypto.encryptForRow(42, { apiKey: 'sk_live_1234' });

    expect(stored['__enc']).toEqual(expect.stringMatching(/^v1\./));
    // TC-10 — ciphertext in the DB, never plaintext.
    expect(JSON.stringify(stored)).not.toContain('sk_live_1234');

    expect(crypto.decryptForRow(42, stored)).toEqual({ apiKey: 'sk_live_1234' });
  });

  it('binds the row id as AAD — a ciphertext copied to a different id fails to decrypt', async () => {
    const crypto = await buildCrypto();
    const stored = crypto.encryptForRow(1, { apiKey: 'sk_live_1234' });

    expect(crypto.decryptForRow(2, stored)).toBeNull();
  });

  it('the two-phase provisional → rebind sequence produces a value readable under the real id', async () => {
    const crypto = await buildCrypto();
    const provisional = crypto.encryptForNewRow({ apiKey: 'sk_live_1234' });

    // Not yet readable under a real id — the AAD is still the provisional placeholder.
    expect(crypto.decryptForRow(99, provisional)).toBeNull();

    const rebound = crypto.rebindToRow(99, provisional);
    expect(crypto.decryptForRow(99, rebound)).toEqual({ apiKey: 'sk_live_1234' });
  });

  it('rebindToRow() throws when given a value that is not a provisional envelope', async () => {
    const crypto = await buildCrypto();
    expect(() => crypto.rebindToRow(1, { notAnEnvelope: true })).toThrow(
      /rebindToRow\(\) called with a value that is not a provisional/,
    );
  });

  it("decryptForRow() returns null for a NULL/empty column (parseJsonColumn's {} fallback)", async () => {
    const crypto = await buildCrypto();
    expect(crypto.decryptForRow(1, {})).toBeNull();
  });

  it('decryptForRow() returns null (never throws) for a value that is not this envelope', async () => {
    const crypto = await buildCrypto();
    expect(crypto.decryptForRow(1, { someOtherKey: 'legacy plain JSON' })).toBeNull();
  });

  it('decryptForRow() returns null (never throws) on a tampered/corrupted ciphertext', async () => {
    const crypto = await buildCrypto();
    const stored = crypto.encryptForRow(1, { apiKey: 'sk_live_1234' });
    const tampered = { __enc: `${String(stored['__enc'])}tampered` };

    // Confirms the tamper genuinely reaches DecryptionError territory before decryptForRow's own
    // try/catch swallows it — proving the null return is deliberate handling, not an accident.
    const fieldCrypto = new FieldCryptoService(await buildDefaultRegistry());
    expect(() =>
      fieldCrypto.decrypt(String(tampered['__enc']), {
        aad: FieldCryptoService.aadFor(REWARD_SYSTEMS_TABLE, 1),
      }),
    ).toThrow(DecryptionError);

    expect(crypto.decryptForRow(1, tampered)).toBeNull();
  });

  it('PROVISIONAL_REWARD_SYSTEM_PK is distinct from an ordinary numeric id', () => {
    expect(PROVISIONAL_REWARD_SYSTEM_PK).toBe('#new-reward-system');
  });
});
