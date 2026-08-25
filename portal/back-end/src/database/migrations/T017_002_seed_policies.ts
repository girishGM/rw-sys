import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds `reward_portal.data_protection_policies` — 07-DATA-PROTECTION.md §6 (which columns), §7
 * (log treatment) and §8 (UI visibility).
 *
 * `ON CONFLICT (policy_key) DO NOTHING`, matching T-004 implementation note 1. **`DO NOTHING`
 * rather than `DO UPDATE` is a decision, not the lazy option:** this table is designed to be
 * edited at runtime — TC-20 changes a policy and invalidates the cache without a restart — so a
 * seed that re-asserted its values on every deployment would silently revert a deliberate
 * operational change the next time anyone ran migrations. Idempotency (TC-22) holds either way;
 * only `DO NOTHING` also leaves the operator in charge of the table afterwards.
 *
 * ---
 *
 * ## Every column verified to exist before it was listed
 *
 * Each `column` row below was checked against `information_schema.columns` on the live database
 * before this file was written (`tenant_api_keys` turned out to have `key_hash`, not the
 * `api_key_hash` a first reading of the design doc suggested). A policy row naming a column that
 * does not exist is not harmless: `installEncryptionHooks` reports it as unmatched and the field
 * is simply never protected — a silent no-op, which is the failure mode this whole subsystem
 * exists to eliminate.
 *
 * ## Why almost every `at_rest` below is `none`, when §6 asks for `aes_256_gcm`
 *
 * §6's table is the target state. Reaching it for an existing column is *"a policy row change
 * plus a backfill migration"*, and each of the four columns below needs something this task does
 * not own before that flip is safe:
 *
 * | column | blocked by |
 * |---|---|
 * | ~~`portal_users.email`~~ | **Unblocked 2026-08-18 by T-056.** It needed four changes this task owns none of: the login path read it with raw SQL (`lower(email) = :email`, T-010/T-011), the bootstrap CLI inserted it with raw SQL (T-004), `uq_portal_users_email_live` indexed `lower(email)`, and there was no `email_bidx` column or model attribute. T-056 made all four and then `UPDATE`s this row to `aes_256_gcm` — an `UPDATE`, because the `DO NOTHING` below means re-seeding would not move it. **The row below still seeds `none` on purpose:** on a fresh database `T017_002` runs before `T056_001`, and the blind-index column that makes encryption survivable does not exist yet at this point in the sequence. Migration order, not a stale value. |
 * | `merchants.contact_email` / `.contact_phone`, `tenants.contact_*` | §6's own boxed warning and BACKLOG B-03: other services and the `create-campaign` agents read these columns **today**. T-044 inventories the consumers first. |
 * | `reward_versions.connector_config` | `trg_reward_versions_immutable` (T-005) rejects any UPDATE on the row. The two-phase AAD binding in `model-encryption.hooks.ts` needs one UPDATE after INSERT to bind the ciphertext to the generated id, so encryption and immutability are mutually exclusive on this table as it stands. Escalated. |
 * | `portal_user_credentials.password_hash` | Not blocked — §6 says `none` on purpose: *"Already Argon2. Encrypting a hash adds nothing and complicates rotation."* |
 *
 * The two rows that **are** `aes_256_gcm` are the two with no existing writer to break:
 * `portal_users.mfa_secret_enc` (written first by T-055) and `portal_sessions.transport_key_enc`
 * (written first by T-018). Both are `secret`, both are `omit`/`never`, and both are exactly the
 * columns §6 names.
 *
 * Every one of those `none`s still gets the three protections this task *does* control today:
 * masked or omitted in logs, masked or absent in responses, and reveal-on-demand behind an
 * audited, rate-limited endpoint. That is §6's own stated position for `reward_config` columns.
 *
 * ## The alias rule: two rows sharing a bare field name must agree on `ui_visibility`
 *
 * A response DTO carries `email`, not `reward_portal.portal_users.email` — there is no container
 * in a plain JSON body — so `ResponseMaskingInterceptor` resolves by bare name, and when several
 * rows share one it takes the **strictest** of them (fail-closed, `policy.service.ts`
 * `strictestOf`). That rule is right and stays. Its consequence is that a stricter row on a
 * table nobody ever returns still masks the field everywhere:
 * `portal_login_attempts.email` was first seeded `masked`, which masked the caller's **own**
 * address on `GET /me` (caught by T-015's e2e suite, not by inspection).
 *
 * So the two `email` rows agree, and this is the rule for anyone adding a row here: **if your
 * column's bare name already exists in this table, either match its `ui_visibility` or accept
 * that yours now governs every response field with that name.** Where a specific screen needs a
 * stricter presentation, the right instrument is a `dto_field` row on *that* screen's response
 * DTO — which is exactly what `scope = 'dto_field'` is for. T-040's audit viewer, if it wants a
 * masked login-attempt address, adds `dto.LoginAttemptDto.email`.
 *
 * ## `portal_users.email` is `ui_visibility: plain`, and that is deliberate
 *
 * Every other PII row here is `masked` or `reveal_on_demand`. This one is not, for two reasons.
 * §6 lists `portal_users.email` under *which columns to encrypt at rest* — its protection is
 * confidentiality in the database and in logs, which this row provides (`mask`/`email`). And the
 * portal's own identity endpoints legitimately show it: `/me` returns the caller their own
 * address, and T-035's user directory shows an admin the accounts they administer. Masking it
 * would break both while protecting it from nobody who is not already authorised to see it, since
 * reaching those endpoints at all is an RBAC decision. Flagged for the reviewer in the completion
 * report as the one PII row that renders in full.
 */

interface SeedPolicy {
  policyKey: string;
  scope: 'column' | 'dto_field';
  classification: 'public' | 'internal' | 'confidential' | 'pii' | 'secret';
  atRest?: 'none' | 'aes_256_gcm' | 'hmac_sha256';
  blindIndex?: boolean;
  inTransit?: 'tls_only' | 'payload_encrypt';
  logTreatment: 'plain' | 'mask' | 'hash' | 'omit';
  maskStrategy?: 'email' | 'phone' | 'last4' | 'first_last' | 'full' | null;
  uiVisibility: 'plain' | 'masked' | 'reveal_on_demand' | 'never';
  revealRoles?: string[] | null;
  keyPurpose?: string | null;
  note: string;
}

/**
 * Exported so `t017-policies.e2e-spec.ts` can assert every `column` row against
 * `information_schema.columns` — the regression guard for the "verified before listed" claim
 * above, which would otherwise decay the first time somebody renames a column.
 */
export const SEEDED_POLICIES: readonly SeedPolicy[] = [
  // --- reward_portal: the portal's own tables ------------------------------------------------
  {
    policyKey: 'reward_portal.portal_users.email',
    scope: 'column',
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'email',
    uiVisibility: 'plain',
    note: 'Login identity. Seeded none; T056_001 raises at_rest to aes_256_gcm once email_bidx exists.',
  },
  {
    policyKey: 'reward_portal.portal_users.display_name',
    scope: 'column',
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'first_last',
    uiVisibility: 'plain',
    note: "A person's name. Rendered in full in the portal; masked in logs.",
  },
  {
    policyKey: 'reward_portal.portal_users.mfa_secret_enc',
    scope: 'column',
    classification: 'secret',
    atRest: 'aes_256_gcm',
    keyPurpose: 'field',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: 'TOTP seed (T-055). Encrypted at rest; never logged, never returned.',
  },
  {
    policyKey: 'reward_portal.portal_user_credentials.password_hash',
    scope: 'column',
    classification: 'secret',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: '07-DATA-PROTECTION.md §6: already Argon2id — encrypting a hash adds nothing.',
  },
  {
    policyKey: 'reward_portal.portal_sessions.transport_key_enc',
    scope: 'column',
    classification: 'secret',
    atRest: 'aes_256_gcm',
    keyPurpose: 'transport',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: 'ECDH-derived session key (T-018). Encrypted at rest.',
  },
  {
    policyKey: 'reward_portal.portal_refresh_tokens.token_hash',
    scope: 'column',
    classification: 'secret',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: 'SHA-256 lookup key for refresh rotation. Encrypting it would break the lookup.',
  },
  {
    policyKey: 'reward_portal.portal_password_resets.token_hash',
    scope: 'column',
    classification: 'secret',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: 'As portal_refresh_tokens.token_hash.',
  },
  {
    policyKey: 'reward_portal.portal_login_attempts.email',
    scope: 'column',
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'email',
    // `plain`, matching portal_users.email — and it has to match. See "the alias rule" below.
    uiVisibility: 'plain',
    note: 'Submitted address on every login attempt. UI visibility must match portal_users.email.',
  },

  // --- reward_config: masking only in v1 (§6 boxed warning, BACKLOG B-03) ---------------------
  {
    policyKey: 'reward_config.merchants.contact_email',
    scope: 'column',
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'email',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin', 'country_admin', 'tenant_admin'],
    note: 'Not encrypted in place: read today by other services (B-03, pending T-044).',
  },
  {
    policyKey: 'reward_config.merchants.contact_phone',
    scope: 'column',
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'phone',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin', 'country_admin', 'tenant_admin'],
    note: 'As merchants.contact_email.',
  },
  {
    policyKey: 'reward_config.tenants.contact_email',
    scope: 'column',
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'email',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin', 'country_admin'],
    note: 'Tenant-level contact; a tenant_admin does not need the address of their own tenant record.',
  },
  {
    policyKey: 'reward_config.tenants.contact_phone',
    scope: 'column',
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'phone',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin', 'country_admin'],
    note: 'As tenants.contact_email.',
  },
  {
    policyKey: 'reward_config.tenant_api_keys.key_hash',
    scope: 'column',
    classification: 'secret',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: 'API key digest. Column is key_hash, not api_key_hash — verified against the live schema.',
  },
  {
    policyKey: 'reward_config.reward_versions.connector_config',
    scope: 'column',
    classification: 'secret',
    logTreatment: 'omit',
    uiVisibility: 'masked',
    note: 'Third-party credentials. at_rest blocked by trg_reward_versions_immutable — see this migration.',
  },

  // --- DTO fields (§5): payload encryption and log suppression -------------------------------
  {
    policyKey: 'dto.LoginRequest.email',
    scope: 'dto_field',
    classification: 'pii',
    inTransit: 'payload_encrypt',
    logTreatment: 'mask',
    maskStrategy: 'email',
    uiVisibility: 'plain',
    note: 'Submitted on the one endpoint that cannot be payload-encrypted yet; masked in logs.',
  },
  {
    policyKey: 'dto.LoginRequest.password',
    scope: 'dto_field',
    classification: 'secret',
    inTransit: 'payload_encrypt',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: 'TC-6: a logged object containing `password` has the key removed entirely.',
  },
  {
    policyKey: 'dto.ChangePasswordRequest.currentPassword',
    scope: 'dto_field',
    classification: 'secret',
    inTransit: 'payload_encrypt',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: '§5 routeOverrides marks POST /auth/change-password as full-body encryption.',
  },
  {
    policyKey: 'dto.ChangePasswordRequest.newPassword',
    scope: 'dto_field',
    classification: 'secret',
    inTransit: 'payload_encrypt',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: 'As currentPassword.',
  },
  {
    policyKey: 'dto.ResetPasswordRequest.newPassword',
    scope: 'dto_field',
    classification: 'secret',
    inTransit: 'payload_encrypt',
    logTreatment: 'omit',
    uiVisibility: 'never',
    note: 'As ChangePasswordRequest.newPassword.',
  },
  {
    policyKey: 'dto.CreateUserResponse.temporaryPassword',
    scope: 'dto_field',
    classification: 'secret',
    inTransit: 'payload_encrypt',
    logTreatment: 'omit',
    uiVisibility: 'plain',
    note: 'Shown once on screen (B-01, T-046): plain in the response by design, never in a log.',
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const policy of SEEDED_POLICIES) {
      await context.query(
        `INSERT INTO reward_portal.data_protection_policies
             (policy_key, scope, classification, at_rest, blind_index, in_transit,
              log_treatment, mask_strategy, ui_visibility, reveal_roles, key_purpose,
              enabled, note)
         VALUES (:policyKey, :scope, :classification, :atRest, :blindIndex, :inTransit,
                 :logTreatment, :maskStrategy, :uiVisibility, CAST(:revealRoles AS jsonb),
                 :keyPurpose, true, :note)
         ON CONFLICT (policy_key) DO NOTHING`,
        {
          type: QueryTypes.INSERT,
          transaction: t,
          replacements: {
            policyKey: policy.policyKey,
            scope: policy.scope,
            classification: policy.classification,
            atRest: policy.atRest ?? 'none',
            blindIndex: policy.blindIndex ?? false,
            inTransit: policy.inTransit ?? 'tls_only',
            logTreatment: policy.logTreatment,
            maskStrategy: policy.maskStrategy ?? null,
            uiVisibility: policy.uiVisibility,
            revealRoles:
              policy.revealRoles === undefined || policy.revealRoles === null
                ? null
                : JSON.stringify(policy.revealRoles),
            keyPurpose: policy.keyPurpose ?? null,
            note: policy.note,
          },
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Deletes exactly the keys this migration seeded, by name.
 *
 * Not `TRUNCATE` and not `DELETE FROM … WHERE true`: a row added at runtime by a security
 * reviewer — which is the documented way to protect a new field — is not this migration's to
 * remove. The same reasoning `T004_006` applies to the pre-existing `approval_policies` row.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `DELETE FROM reward_portal.data_protection_policies WHERE policy_key IN (:keys)`,
    {
      type: QueryTypes.DELETE,
      replacements: { keys: SEEDED_POLICIES.map((policy) => policy.policyKey) },
    },
  );
}
