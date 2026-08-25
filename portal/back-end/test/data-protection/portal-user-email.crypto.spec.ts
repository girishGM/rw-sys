/**
 * T-056 — `PortalUserEmailCrypto`, the shared at-rest applier for the raw-SQL authentication paths.
 *
 * The single most important assertion in this file is the **interoperability** one: a value written
 * by `model-encryption.hooks.ts` must be readable by this class and vice versa. They are separate
 * implementations of the same AAD convention (neither may import the other's internals), which is
 * exactly the arrangement that silently drifts. If the two ever disagree, login breaks for every
 * user created through the model path — and nothing else in the suite would notice.
 */
import { BlindIndexService, FieldCryptoService, looksLikeCiphertext } from '@/common/crypto';
import {
  PortalUserEmailCrypto,
  PORTAL_USERS_EMAIL_POLICY_KEY,
  PORTAL_USERS_TABLE,
} from '@/common/data-protection/portal-user-email.crypto';
import { PROVISIONAL_PK } from '@/common/data-protection/model-encryption.hooks';
import { UNDECRYPTABLE_SENTINEL } from '@/common/data-protection/data-protection.constants';
import { buildDefaultRegistry } from '../crypto/support/keys';

async function build(bindRecordIdAsAAD = true): Promise<{
  crypto: PortalUserEmailCrypto;
  fieldCrypto: FieldCryptoService;
  blindIndex: BlindIndexService;
}> {
  const registry = await buildDefaultRegistry();
  const fieldCrypto = new FieldCryptoService(registry);
  const blindIndex = new BlindIndexService(registry);
  return {
    crypto: new PortalUserEmailCrypto(fieldCrypto, blindIndex, bindRecordIdAsAAD),
    fieldCrypto,
    blindIndex,
  };
}

describe('PortalUserEmailCrypto', () => {
  describe('blindIndexFor', () => {
    it('TC-2: normalises case and surrounding whitespace to one index', async () => {
      const { crypto } = await build();

      const canonical = crypto.blindIndexFor('foo@bar.com');

      expect(crypto.blindIndexFor('Foo@Bar.com')).toBe(canonical);
      expect(crypto.blindIndexFor(' foo@bar.com ')).toBe(canonical);
      expect(crypto.blindIndexFor('FOO@BAR.COM')).toBe(canonical);
    });

    it('produces 64 lowercase hex characters, the width of the column', async () => {
      const { crypto } = await build();
      expect(crypto.blindIndexFor('foo@bar.com')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('separates distinct addresses', async () => {
      const { crypto } = await build();
      expect(crypto.blindIndexFor('a@bar.com')).not.toBe(crypto.blindIndexFor('b@bar.com'));
    });

    /**
     * The index must come from T-016's registered rule for this field, not a local
     * `trim().toLowerCase()`. Asserting equality with the registry's own output is what pins that:
     * the registered `email` rule applies Unicode NFKC first, which a hand-rolled copy would not.
     */
    it('delegates to the field-registered normaliser rather than re-implementing it', async () => {
      const { crypto, blindIndex } = await build();

      // A full-width address — NFKC folds it to ASCII, a naive lowercase does not.
      const fullWidth = 'ｆｏｏ@bar.com';

      expect(crypto.blindIndexFor(fullWidth)).toBe(
        blindIndex.computeForField(PORTAL_USERS_EMAIL_POLICY_KEY, fullWidth),
      );
      expect(crypto.blindIndexFor(fullWidth)).toBe(crypto.blindIndexFor('foo@bar.com'));
    });
  });

  describe('encrypt / decrypt round trip', () => {
    it('returns an envelope, never the plaintext', async () => {
      const { crypto } = await build();

      const stored = crypto.encryptForRow(42, 'operator@example.com');

      expect(looksLikeCiphertext(stored)).toBe(true);
      expect(stored).not.toContain('operator@example.com');
      expect(crypto.decryptForRow(42, stored)).toBe('operator@example.com');
    });

    it('produces a different ciphertext each time (random IV), which is why the index exists', async () => {
      const { crypto } = await build();

      const a = crypto.encryptForRow(42, 'operator@example.com');
      const b = crypto.encryptForRow(42, 'operator@example.com');

      expect(a).not.toBe(b);
      expect(crypto.blindIndexFor('operator@example.com')).toBe(
        crypto.blindIndexFor('operator@example.com'),
      );
    });

    it('binds the ciphertext to its row: another row cannot decrypt it', async () => {
      const { crypto } = await build();

      const stored = crypto.encryptForRow(42, 'operator@example.com');

      expect(crypto.decryptForRow(43, stored)).toBe(UNDECRYPTABLE_SENTINEL);
    });

    it('degrades to the sentinel rather than throwing on a damaged value', async () => {
      const { crypto } = await build();
      expect(crypto.decryptForRow(42, 'v1.fld_2026_01.AAAA.BBBB.CCCC')).toBe(
        UNDECRYPTABLE_SENTINEL,
      );
    });

    it('passes a non-envelope through unchanged (a row written before the migration)', async () => {
      const { crypto } = await build();
      expect(crypto.decryptForRow(42, 'legacy@example.com')).toBe('legacy@example.com');
    });

    it('maps null to null', async () => {
      const { crypto } = await build();
      expect(crypto.decryptForRow(42, null)).toBeNull();
    });
  });

  describe('the two-phase INSERT path', () => {
    it('encrypts under the placeholder, then re-binds to the real id', async () => {
      const { crypto } = await build();

      const provisional = crypto.encryptForNewRow('operator@example.com');
      // Before the re-bind the value belongs to no row, so the real row cannot read it.
      expect(crypto.decryptForRow(42, provisional)).toBe(UNDECRYPTABLE_SENTINEL);

      const rebound = crypto.rebindToRow(42, provisional);
      expect(rebound).not.toBeNull();
      expect(crypto.decryptForRow(42, rebound)).toBe('operator@example.com');
    });

    it('returns null when there is nothing to re-bind', async () => {
      const { crypto } = await build();
      expect(crypto.rebindToRow(42, 'not-an-envelope')).toBeNull();
    });
  });

  /**
   * The constructor defaults `bindRecordIdAsAAD` to `true`. That default is what a caller who omits
   * the argument silently gets, and getting it wrong would mean unbound ciphertext — the exact
   * downgrade §4 exists to prevent — so it is pinned rather than assumed.
   */
  it('defaults to binding the record id when the flag is omitted', async () => {
    const registry = await buildDefaultRegistry();
    const crypto = new PortalUserEmailCrypto(
      new FieldCryptoService(registry),
      new BlindIndexService(registry),
    );

    const stored = crypto.encryptForRow(42, 'operator@example.com');

    expect(crypto.decryptForRow(42, stored)).toBe('operator@example.com');
    // Bound: another row cannot read it. If the default were `false` this would succeed.
    expect(crypto.decryptForRow(43, stored)).toBe(UNDECRYPTABLE_SENTINEL);
  });

  describe('bindRecordIdAsAAD = false (the documented §10 downgrade)', () => {
    it('makes a ciphertext readable from any row, and needs no re-bind', async () => {
      const { crypto } = await build(false);

      const stored = crypto.encryptForRow(42, 'operator@example.com');

      // No longer row-bound — that is the whole meaning of the flag.
      expect(crypto.decryptForRow(999, stored)).toBe('operator@example.com');
      // And the provisional value is already final, so no UPDATE is owed.
      expect(crypto.rebindToRow(42, crypto.encryptForNewRow('operator@example.com'))).toBeNull();
    });
  });

  /**
   * The interoperability guarantee. `model-encryption.hooks.ts` builds its AAD from
   * `FieldCryptoService.aadFor(table, pk)` with the same `PROVISIONAL_PK` placeholder; this class
   * must agree exactly, or values written through a Sequelize model become unreadable on the login
   * path and vice versa.
   */
  describe('agreement with model-encryption.hooks', () => {
    it('reads a ciphertext built with the hooks own AAD convention', async () => {
      const { crypto, fieldCrypto } = await build();

      const asHooksWouldWrite = fieldCrypto.encrypt('operator@example.com', {
        aad: FieldCryptoService.aadFor(PORTAL_USERS_TABLE, 42),
      });

      expect(crypto.decryptForRow(42, asHooksWouldWrite)).toBe('operator@example.com');
    });

    it('writes a ciphertext the hooks own AAD convention can read', async () => {
      const { crypto, fieldCrypto } = await build();

      const stored = crypto.encryptForRow(42, 'operator@example.com');

      expect(
        fieldCrypto.decrypt(stored, { aad: FieldCryptoService.aadFor(PORTAL_USERS_TABLE, 42) }),
      ).toBe('operator@example.com');
    });

    it('uses the same provisional placeholder the hooks use', async () => {
      const { crypto, fieldCrypto } = await build();

      const provisional = crypto.encryptForNewRow('operator@example.com');

      expect(
        fieldCrypto.decrypt(provisional, {
          aad: FieldCryptoService.aadFor(PORTAL_USERS_TABLE, PROVISIONAL_PK),
        }),
      ).toBe('operator@example.com');
    });
  });
});
