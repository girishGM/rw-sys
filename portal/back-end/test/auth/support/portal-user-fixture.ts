/**
 * T-056 e2e support — creating and finding `portal_users` rows now that `email` is encrypted.
 *
 * ### Why every e2e suite needed changing
 *
 * Before T-056 a fixture could `INSERT INTO reward_portal.portal_users (email, …) VALUES
 * ('someone@example.com', …)` and then log that user in. It cannot any more, for two independent
 * reasons:
 *
 *  1. **The login lookup is on `email_bidx`, not the address.** A row inserted without an index is
 *     invisible to `POST /auth/login`, to the forgot-password lookup, and to
 *     `uq_portal_users_email_live` — which, being a unique index over a NULL column, also stops
 *     rejecting duplicates. The row exists and nothing can find it.
 *  2. **The column is ciphertext.** A plaintext row still *reads* fine (`PortalUserEmailCrypto`
 *     passes non-envelopes through, deliberately, so a pre-migration row is not a crash), but it
 *     is no longer testing what production does.
 *
 * So fixtures go through {@link insertPortalUser}, which writes exactly what the application writes:
 * an envelope bound to the row's own id, plus the blind index. Using the *real*
 * `PortalUserEmailCrypto` from the running application — rather than a test-local copy of the
 * encryption logic — is the point. A helper with its own idea of the AAD or the normalisation would
 * let the suites pass while production was broken, which is the one outcome that would make this
 * whole task worthless.
 *
 * ### The keys
 *
 * `KeyRegistryService` reads `encryption_keys` **once, at `app.init()`**, so
 * {@link ensureEncryptionKeys} must be called before it. It generates both keys' material into
 * `process.env` per run and never writes it down (R4), and inserts each row as `active` only when
 * the deployment has none of that purpose — `uq_ek_active_purpose` permits exactly one, and a real
 * key configuration must not be disturbed by a test run.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { INestApplication } from '@nestjs/common';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { generateKeyMaterial, sweepOrphanedTestKeys } from '../../support/encryption-keys';

/** Both kids a suite owns, namespaced so two suites cannot delete each other's rows. */
export function keyIdsFor(suite: string): { field: string; blindIndex: string } {
  return { field: `${suite}_t056_fld`, blindIndex: `${suite}_t056_bidx` };
}

function envNamesFor(suite: string): { field: string; blindIndex: string } {
  return {
    field: `${suite.toUpperCase()}_T056_FIELD_KEY`,
    blindIndex: `${suite.toUpperCase()}_T056_BLIND_KEY`,
  };
}

/**
 * Ensures an active `field` **and** `blind_index` key exist. Call before `app.init()`.
 *
 * Both are needed now: `field` encrypts the address, `blind_index` computes the lookup key, and a
 * login touches both on every attempt.
 */
export async function ensureEncryptionKeys(sequelize: Sequelize, suite: string): Promise<void> {
  const kids = keyIdsFor(suite);
  const envs = envNamesFor(suite);

  process.env[envs.field] = generateKeyMaterial();
  process.env[envs.blindIndex] = generateKeyMaterial();

  // T-067 — clear residue from any *previously killed* run before inserting. The `afterAll`
  // that would normally have removed those rows never executed, and every one of them will
  // fail `KeyRegistryService.load()` at the `app.init()` a few lines from now, taking this
  // suite down over a row it never created. See `test/support/encryption-keys.ts` for why
  // deleting them is lossless and why the registry's own check was left strict.
  await sweepOrphanedTestKeys(sequelize);

  await removeEncryptionKeys(sequelize, suite, { keepEnv: true });

  await sequelize.query(
    `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
     VALUES (:fieldKid, 'field', 'AES-256-GCM', :fieldRef,
             CASE WHEN EXISTS (SELECT 1 FROM reward_portal.encryption_keys
                                WHERE purpose = 'field' AND status = 'active')
                  THEN 'rotating' ELSE 'active' END),
            (:bidxKid, 'blind_index', 'HMAC-SHA256', :bidxRef,
             CASE WHEN EXISTS (SELECT 1 FROM reward_portal.encryption_keys
                                WHERE purpose = 'blind_index' AND status = 'active')
                  THEN 'rotating' ELSE 'active' END)`,
    {
      type: QueryTypes.INSERT,
      replacements: {
        fieldKid: kids.field,
        fieldRef: `env:${envs.field}`,
        bidxKid: kids.blindIndex,
        bidxRef: `env:${envs.blindIndex}`,
      },
    },
  );
}

/** Removes both rows and both environment variables. Safe when neither exists. */
export async function removeEncryptionKeys(
  sequelize: Sequelize,
  suite: string,
  options: { keepEnv?: boolean } = {},
): Promise<void> {
  const kids = keyIdsFor(suite);
  await sequelize.query(`DELETE FROM reward_portal.encryption_keys WHERE kid IN (:kids)`, {
    type: QueryTypes.DELETE,
    replacements: { kids: [kids.field, kids.blindIndex] },
  });
  if (options.keepEnv !== true) {
    const envs = envNamesFor(suite);
    delete process.env[envs.field];
    delete process.env[envs.blindIndex];
  }
}

/** The application's own email crypto — never a test-local reimplementation. See the header. */
export function emailCryptoOf(app: INestApplication): PortalUserEmailCrypto {
  return app.get(PortalUserEmailCrypto);
}

export interface PortalUserFixture {
  email: string;
  displayName: string;
  role: string;
  countryId?: number | null;
  tenantId?: number | null;
  merchantId?: number | null;
  status?: string;
  mustChangePassword?: boolean;
  preferredLocale?: string | null;
  preferredTimezone?: string | null;
}

/**
 * Inserts a `portal_users` row the way the application would: ciphertext plus blind index.
 *
 * Two-phase, mirroring `model-encryption.hooks.ts` and `bootstrap-superadmin.ts` — the id that gets
 * bound into the ciphertext as AAD does not exist until the INSERT has returned it, so the row is
 * written under the `#new` placeholder and immediately re-bound. Plaintext is never written.
 */
export async function insertPortalUser(
  sequelize: Sequelize,
  crypto: PortalUserEmailCrypto,
  fixture: PortalUserFixture,
): Promise<number> {
  const [created] = await sequelize.query<{ id: number }>(
    `INSERT INTO reward_portal.portal_users
            (email, email_bidx, display_name, role, country_id, tenant_id, merchant_id,
             status, must_change_password, preferred_locale, preferred_timezone)
     VALUES (:email, :emailBidx, :displayName, :role, :countryId, :tenantId, :merchantId,
             :status, :mustChangePassword, :preferredLocale, :preferredTimezone)
     RETURNING id`,
    {
      type: QueryTypes.SELECT,
      replacements: {
        email: crypto.encryptForNewRow(fixture.email),
        emailBidx: crypto.blindIndexFor(fixture.email),
        displayName: fixture.displayName,
        role: fixture.role,
        countryId: fixture.countryId ?? null,
        tenantId: fixture.tenantId ?? null,
        merchantId: fixture.merchantId ?? null,
        status: fixture.status ?? 'active',
        mustChangePassword: fixture.mustChangePassword ?? false,
        preferredLocale: fixture.preferredLocale ?? 'en',
        preferredTimezone: fixture.preferredTimezone ?? null,
      },
    },
  );

  await sequelize.query(`UPDATE reward_portal.portal_users SET email = :email WHERE id = :id`, {
    type: QueryTypes.UPDATE,
    replacements: { email: crypto.encryptForRow(created.id, fixture.email), id: created.id },
  });

  return created.id;
}

/**
 * Deletes fixture users by address.
 *
 * Replaces the `WHERE lower(email) IN (:emails)` cleanup every suite used to run, which now matches
 * nothing at all — and would leave rows behind that collide with the next run on
 * `uq_portal_users_email_live`.
 */
export async function deletePortalUsersByEmail(
  sequelize: Sequelize,
  crypto: PortalUserEmailCrypto,
  emails: readonly string[],
): Promise<void> {
  if (emails.length === 0) return;
  await sequelize.query(`DELETE FROM reward_portal.portal_users WHERE email_bidx IN (:bidx)`, {
    type: QueryTypes.DELETE,
    replacements: { bidx: emails.map((email) => crypto.blindIndexFor(email)) },
  });
}

/** Finds a user id by address, through the blind index. */
export async function findPortalUserIdByEmail(
  sequelize: Sequelize,
  crypto: PortalUserEmailCrypto,
  email: string,
): Promise<number | undefined> {
  const [row] = await sequelize.query<{ id: number }>(
    `SELECT id FROM reward_portal.portal_users
      WHERE email_bidx = :bidx AND deleted_at IS NULL LIMIT 1`,
    { type: QueryTypes.SELECT, replacements: { bidx: crypto.blindIndexFor(email) } },
  );
  return row?.id;
}
