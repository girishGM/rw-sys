import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes, type Transaction } from 'sequelize';
import {
  BlindIndexService,
  BLIND_INDEX_HEX_LENGTH,
  EnvKeyMaterialResolver,
  FieldCryptoService,
  KeyRegistryService,
  looksLikeCiphertext,
  UnconfiguredKmsResolver,
} from '@/common/crypto';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { dataProtectionConfigFactory } from '@/common/data-protection/data-protection.config';
import { UNDECRYPTABLE_SENTINEL } from '@/common/data-protection/data-protection.constants';

/**
 * T-056 — encrypts `reward_portal.portal_users.email` at rest and gives it a blind index.
 *
 * T-017 seeded this column's policy row as `at_rest: none` and said why, in a table in
 * `T017_002_seed_policies.ts`: four things read or write the column outside Sequelize, so flipping
 * the policy without changing them first breaks login *and* the bootstrap CLI. This migration is
 * the database half of that coordinated change; the application half is in `credential.repository.ts`,
 * `session.repository.ts`, `mfa.repository.ts`, `portal-user.model.ts` and `bootstrap-superadmin.ts`.
 *
 * ## The four statements, and the two the task file did not anticipate
 *
 * 1. `email_bidx varchar(64)` — the deterministic lookup key. Width from `BLIND_INDEX_HEX_LENGTH`
 *    rather than a literal `64`, so a change to the digest width cannot leave the column behind.
 * 2. **`email` is widened `varchar(200)` → `varchar(512)`.** *Not in the task file, and not
 *    optional.* A `v1.<kid>.<iv>.<tag>.<ct>` envelope around a 200-character address is ~358
 *    characters, so encrypting into the existing column would fail with `value too long for type
 *    character varying(200)` — on the bootstrap CLI's very first INSERT, and on nothing else, which
 *    is the worst possible place to discover it. 512 is the width `mfa_secret_enc` already uses for
 *    the same reason. The *validation* limit stays 200 (`auth-request.dto.ts`); this is storage
 *    headroom for the envelope, not permission to hold a longer address.
 * 3. `uq_portal_users_email_live` moves from `lower(email)` to `email_bidx`. It has to move: every
 *    encryption uses a random IV, so the same address produces different ciphertext every time and
 *    a uniqueness index over `lower(email)` would stop rejecting duplicates entirely — silently.
 *    The blind index is the only value that is both stable and equality-comparable.
 * 4. The policy row flips to `at_rest = 'aes_256_gcm'` **and `blind_index = true`.** The task file
 *    named only `at_rest`; `blind_index` is required with it, because `resolveField()` in
 *    `model-encryption.hooks.ts` only maintains `email_bidx` when the policy row asks for an index.
 *    Setting `at_rest` alone would encrypt the column and never populate the index — i.e. exactly
 *    the silent, total login failure that hook's own comment warns about.
 *
 * ## Keys are required only when there is something to encrypt — and why that is the safe rule
 *
 * `encryption_keys` is seeded by no migration on purpose (T016_001: *"which kids exist, and which
 * env vars hold them, is a deployment decision"*), so this migration can legitimately run on a
 * database that has no key configured yet. Two candidate rules, and why the second one wins:
 *
 *  - *Always require an active `field` + `blind_index` key.* Fail-closed, but it makes
 *    `npm run db:migrate` impossible on any fresh clone until someone provisions key material —
 *    including every other agent's environment and CI, neither of which has a user row to protect.
 *  - **Require them only when a row actually has to be encrypted.** This is what
 *    {@link buildCrypto} implements, by being called only after the backfill finds work to do.
 *
 * The second is not a weakening, because there is no path to a plaintext address surviving it. On a
 * populated database the keys are mandatory and the migration refuses without them. On an empty one
 * every route to creating the first user already fails loudly on its own: `bootstrap-superadmin.ts`
 * resolves both keys before it opens its transaction, and the application's own user creation goes
 * through the model hooks, which throw rather than write an unencrypted value. So a deployment that
 * migrates without keys gets a clear, early error the first time it tries to create an account —
 * never a silently plaintext column, and never a silently broken login.
 *
 * What this migration must never do is flip the policy *and* leave existing rows readable in the
 * clear, which is why the backfill and the policy UPDATE are in the same transaction.
 *
 * ## Backfill
 *
 * Every existing row is encrypted in place, soft-deleted rows included — the policy is a property of
 * the column, not of the live subset, and a soft-deleted user's address is exactly as personal as an
 * active one's. Rows are processed one at a time because each ciphertext is bound to its own primary
 * key as AAD (§4), so there is no set-based form of this UPDATE. `looksLikeCiphertext` makes the
 * backfill idempotent, so a migration re-run after a partial failure re-encrypts nothing.
 */

/** `field` + `blind_index`, the two purposes this column depends on. */
async function buildCrypto(context: Sequelize): Promise<PortalUserEmailCrypto> {
  const registry = new KeyRegistryService(context, [
    new EnvKeyMaterialResolver(),
    new UnconfiguredKmsResolver(),
  ]);
  await registry.load();

  // Resolving both up front turns "no key" into a migration failure rather than a runtime one.
  // `getActiveKey` throws a KeyRegistryError naming the purpose, which is already the actionable
  // message; wrapping it would only bury the detail.
  registry.getActiveKey('field');
  registry.getActiveKey('blind_index');

  // Record binding is read from the same config the hooks are given, so a deployment that has
  // switched it off backfills values its own hooks can read. Defaulting to `true` here and `false`
  // in the hooks (or vice versa) would produce a table nothing can decrypt.
  const config = dataProtectionConfigFactory();

  return new PortalUserEmailCrypto(
    new FieldCryptoService(registry),
    new BlindIndexService(registry),
    config.atRest.bindRecordIdAsAAD,
  );
}

interface EmailRow {
  id: number;
  email: string;
}

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_portal.portal_users
         ADD COLUMN email_bidx varchar(${String(BLIND_INDEX_HEX_LENGTH)}) NULL`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Statement 2 — see the header. Must happen before the backfill writes an envelope.
    await context.query(
      `ALTER TABLE reward_portal.portal_users ALTER COLUMN email TYPE varchar(512)`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await backfill(context, t);

    // The old index is dropped only after the backfill has populated every `email_bidx`, so the
    // table is never without a uniqueness guarantee on the address — `lower(email)` still holds
    // while the rows are being rewritten, and `email_bidx` takes over in the same transaction.
    await context.query(`DROP INDEX reward_portal.uq_portal_users_email_live`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(
      `CREATE UNIQUE INDEX uq_portal_users_email_live
          ON reward_portal.portal_users(email_bidx) WHERE deleted_at IS NULL`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // An UPDATE, not an INSERT: T017_002 seeded this row `ON CONFLICT DO NOTHING`, so it already
    // exists and a second INSERT would silently do nothing at all.
    // `key_purpose` is not optional alongside `at_rest`: `ck_dpp_at_rest_key_purpose` (T017_001)
    // rejects an encrypted row that names no key ring, on the grounds that the hook generator
    // would have nothing to look up. `'field'` is the ring `mfa_secret_enc` already uses — this
    // column is encrypted with the same `field` key, not one of its own.
    const [, result] = await context.query(
      `UPDATE reward_portal.data_protection_policies
          SET at_rest = 'aes_256_gcm', blind_index = true, key_purpose = 'field',
              updated_at = now()
        WHERE policy_key = 'reward_portal.portal_users.email'`,
      { type: QueryTypes.UPDATE, transaction: t },
    );
    assertOnePolicyRowUpdated(result);

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    // Decrypt first: the plaintext has to be back in the column before an index over `lower(email)`
    // means anything, and before the column is narrowed back to 200.
    //
    // Symmetrically to `up()`, the key is resolved only if there is actually a ciphertext to read,
    // so rolling back a migration that never encrypted anything needs no key configuration.
    const rows = await context.query<EmailRow>(
      `SELECT id, email FROM reward_portal.portal_users ORDER BY id`,
      { type: QueryTypes.SELECT, transaction: t },
    );
    const encrypted = rows.filter((row) => looksLikeCiphertext(row.email));

    if (encrypted.length > 0) {
      const crypto = await buildCrypto(context);
      for (const row of encrypted) {
        const plaintext = crypto.decryptForRow(row.id, row.email);
        // A row that will not decrypt must stop the rollback. Writing the sentinel into the column
        // would silently destroy the address — and `down()` is supposed to be the safe direction.
        if (plaintext === null || plaintext === UNDECRYPTABLE_SENTINEL) {
          throw new Error(
            `T056_001 down(): portal_users.${String(row.id)}.email could not be decrypted, so ` +
              `rolling back would replace the address with a placeholder and lose it. Restore the ` +
              `encryption key that wrote this row, then retry the rollback.`,
          );
        }
        await context.query(`UPDATE reward_portal.portal_users SET email = :email WHERE id = :id`, {
          type: QueryTypes.UPDATE,
          transaction: t,
          replacements: { email: plaintext, id: row.id },
        });
      }
    }

    await context.query(`DROP INDEX reward_portal.uq_portal_users_email_live`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(
      `CREATE UNIQUE INDEX uq_portal_users_email_live
          ON reward_portal.portal_users(lower(email)) WHERE deleted_at IS NULL`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(`ALTER TABLE reward_portal.portal_users DROP COLUMN email_bidx`, {
      type: QueryTypes.RAW,
      transaction: t,
    });

    // Narrowing back is safe because every value is plaintext again, and plaintext was constrained
    // to 200 before this migration ran. If a row somehow exceeds it, Postgres refuses loudly here
    // rather than truncating — the correct outcome for an address that would otherwise be corrupted.
    await context.query(
      `ALTER TABLE reward_portal.portal_users ALTER COLUMN email TYPE varchar(200)`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // `key_purpose` back to NULL with `at_rest` back to `none` — the pair `ck_dpp_at_rest_key_purpose`
    // constrains, restored to exactly the state T017_002 seeded.
    await context.query(
      `UPDATE reward_portal.data_protection_policies
          SET at_rest = 'none', blind_index = false, key_purpose = NULL, updated_at = now()
        WHERE policy_key = 'reward_portal.portal_users.email'`,
      { type: QueryTypes.UPDATE, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Encrypts every plaintext row and computes its index.
 *
 * The id is already assigned for an existing row, so the ciphertext is bound to the real primary key
 * directly — none of the two-phase `PROVISIONAL_PK` dance the INSERT path needs.
 */
async function backfill(context: Sequelize, t: Transaction): Promise<void> {
  const rows = await context.query<EmailRow>(
    `SELECT id, email FROM reward_portal.portal_users ORDER BY id`,
    { type: QueryTypes.SELECT, transaction: t },
  );

  // Every row already encrypted, or no rows at all: nothing needs a key, so do not demand one.
  // See the "Keys are required only when there is something to encrypt" section in the header.
  const pending = rows.filter((row) => !looksLikeCiphertext(row.email));
  if (pending.length === 0) return;

  const crypto = await buildCrypto(context);

  // `pending` already excludes anything that is an envelope, which is what makes a re-run after a
  // partial failure safe: encrypting an envelope a second time yields a value whose plaintext is a
  // ciphertext, and that is unrecoverable.
  for (const row of pending) {
    await context.query(
      `UPDATE reward_portal.portal_users
          SET email = :email, email_bidx = :bidx
        WHERE id = :id`,
      {
        type: QueryTypes.UPDATE,
        transaction: t,
        replacements: {
          email: crypto.encryptForRow(row.id, row.email),
          bidx: crypto.blindIndexFor(row.email),
          id: row.id,
        },
      },
    );
  }
}

/**
 * The policy flip is the whole point of this migration; an UPDATE that matched nothing means
 * `T017_002` did not run, or the key was renamed. Either way the column would be encrypted by the
 * hooks only if the row said so — and it would not — so the migration must fail rather than leave a
 * widened, indexed column that nothing ever encrypts.
 */
function assertOnePolicyRowUpdated(affected: unknown): void {
  if (typeof affected === 'number' && affected !== 1) {
    throw new Error(
      `T056_001 expected to update exactly 1 data_protection_policies row for ` +
        `'reward_portal.portal_users.email', but updated ${String(affected)}. The policy row ` +
        `T017_002 seeds is missing or renamed; without it the encryption hooks never install and ` +
        `the column stays plaintext behind an index that implies otherwise.`,
    );
  }
}
