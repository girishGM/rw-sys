/**
 * T-050 — direct Postgres access, used only where no portal API can do the job:
 *
 *  - loading `database/reward_config_postgres.sql` (the legacy schema this portal is a front end
 *    onto — nothing in `portal/` owns or migrates it, see `00-ARCHITECTURE.md`) into the fresh
 *    Testcontainers database before `db:migrate` ever runs;
 *  - seeding the encryption-key rows T-016/T-056 deliberately leave for a deployment to insert
 *    (`T016_001_encryption_keys.ts`'s own header: "no rows are seeded here... a deployment
 *    decision");
 *  - seeding the handful of `reward_config` reference rows (rule categories/sub-categories,
 *    activity categories/types) that the real corporate system would already hold in production
 *    but that no REST endpoint in this portal can create (`AddMerchantActivityModal.tsx`'s own
 *    header flags the `activities` half of this gap already; rule categories are the same shape
 *    — see the completion report).
 *  - creating the `reward_app` role itself (`ensureAppRoleExists`, T-078) before `db:migrate`
 *    ever runs, on a fresh Testcontainers instance that has no such role until this suite makes
 *    one. See that function's own header for the full story.
 *
 * Everything else in this suite goes through the HTTP API or the browser, never this file —
 * R2's "never bypass `ScopedRepository`" is a back-end rule about application code, but the same
 * spirit applies here: a test that reaches around the API to fabricate the very state the API is
 * supposed to produce is not testing the API.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

export interface DbConnectionInfo {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

export async function withClient<T>(
  info: DbConnectionInfo,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: info.host,
    port: info.port,
    database: info.database,
    user: info.username,
    password: info.password,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates the `reward_app` role `T002_008_grants.ts` targets, if it does not already exist —
 * T-078.
 *
 * `T002_008_grants.ts`'s very first statement is `GRANT USAGE, CREATE ON SCHEMA reward_portal TO
 * reward_app`, and that migration is correct to assume the role already exists: in every real,
 * non-ephemeral environment (including this machine's own shared local Postgres — CLAUDE.md's
 * "Local environment" section) a deployment provisions `reward_app` out of band, once, long
 * before `db:migrate` ever runs. A fresh Testcontainers `postgres:16` instance has no such
 * out-of-band step and starts with only the `postgres` superuser — nothing in `global-setup.ts`
 * ever created `reward_app` inside it before handing the container to `db:migrate`, so that
 * migration's first statement failed with a real Postgres 42704 (`undefined_object`) error,
 * every time the primary (container) provisioning strategy was taken. Reproduced live, T-078,
 * 2026-08-21 (see the completion report) — the suite's own Docker-less fallback
 * (`localPostgres.ts`) never showed this, purely because it happens to run against a server that
 * already has the role for the unrelated reason above, not because the bug wasn't there.
 *
 * `NOLOGIN`, no password: nothing in this suite ever authenticates *as* `reward_app` —
 * `global-setup.ts`'s own `baseEnv` comment already discloses that both `DB_APP_*` and
 * `DB_MIGRATION_*` point at the same superuser connection here, a deliberate collapse of the
 * migration/app-role split for this disposable database. This function exists purely to give
 * `T002_008_grants.ts`'s `GRANT ... TO reward_app` statements a role to target, mirroring the
 * *shape* of what a real deployment's provisioning already produces, without pretending this
 * suite exercises the least-privilege login itself — that split is `back-end/test/database`'s
 * job, not this one's.
 *
 * Idempotent by checking `pg_roles` first rather than attempting `CREATE ROLE` and swallowing a
 * "already exists" error: `CREATE ROLE` has no `IF NOT EXISTS` form, and catching a specific
 * Postgres error code to ignore it is exactly the kind of silent-skip T-002 note 6 (referenced in
 * `T002_008_grants.ts`'s own header) warns against elsewhere in this schema. Safe to call every
 * run regardless of provisioning strategy: a fresh container never has the role (creates it), the
 * local fallback always already does (no-ops).
 */
export async function ensureAppRoleExists(info: DbConnectionInfo, roleName = 'reward_app'): Promise<void> {
  await withClient(info, async (client) => {
    const existing = await client.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = $1',
      [roleName],
    );
    if (existing.rowCount === 0) {
      // Identifier interpolation, not a bound query parameter — CREATE ROLE's grammar does not
      // allow one, the same constraint `createEphemeralDatabase`'s CREATE DATABASE above has.
      // `roleName` defaults to the literal constant `T002_008_grants.ts` hard-codes (`APP_ROLE`)
      // and is never taken from client/user input.
      await client.query(`CREATE ROLE "${roleName}" NOLOGIN`);
    }
  });
}

/** `database/reward_config_postgres.sql` lives at the git-repo root, one level above `portal/`
 * (see `CLAUDE.md`'s repo map) — outside this task's file scope to edit, but not to read: it is
 * input data for this setup step, the same relationship a migration has to the schema it targets. */
export function readRewardConfigSchemaSql(): string {
  const sqlPath = path.resolve(__dirname, '..', '..', '..', 'database', 'reward_config_postgres.sql');
  return readFileSync(sqlPath, 'utf8');
}

export async function loadRewardConfigSchema(info: DbConnectionInfo): Promise<void> {
  const sql = readRewardConfigSchemaSql();
  await withClient(info, async (client) => {
    await client.query(sql);
  });
}

export interface SeedIds {
  readonly ruleSubCategoryId: number;
  readonly activityCategoryId: number;
  readonly activityTypeId: number;
  readonly seedTenantId: number;
}

/**
 * The seed country/tenant + reference rows described in this file's header. `SEED`-prefixed and
 * isolated from the country/tenant every spec creates through the real onboarding flow — nothing
 * in the product ever shows this row to a user, it exists only so a rule/activity can be
 * authored at all (both tables' `tenant_id`/`category_id` are `not null` foreign keys).
 */
export async function seedReferenceData(info: DbConnectionInfo): Promise<SeedIds> {
  return withClient(info, async (client) => {
    const country = await client.query<{ id: number }>(
      `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, is_hq, status)
       VALUES ('ZZ', 'E2E Seed Country', 'UTC', 'USD', '+0', false, 'active')
       RETURNING id`,
    );
    const tenant = await client.query<{ id: number }>(
      `INSERT INTO reward_config.tenants (code, name, country_id, status)
       VALUES ('E2ESEED', 'E2E Seed Data Tenant', $1, 'active')
       RETURNING id`,
      [country.rows[0].id],
    );
    const seedTenantId = tenant.rows[0].id;

    const ruleCategory = await client.query<{ id: number }>(
      `INSERT INTO reward_config.rule_categories (tenant_id, category_code, name, status)
       VALUES ($1, 'E2E_CAT', 'E2E rule category', 'active')
       RETURNING id`,
      [seedTenantId],
    );
    const ruleSubCategory = await client.query<{ id: number }>(
      `INSERT INTO reward_config.rule_sub_categories (category_id, sub_category_code, name, status)
       VALUES ($1, 'E2E_SUBCAT', 'E2E rule sub-category', 'active')
       RETURNING id`,
      [ruleCategory.rows[0].id],
    );

    const activityCategory = await client.query<{ id: number }>(
      `INSERT INTO reward_config.activity_categories (tenant_id, category_code, name, status)
       VALUES ($1, 'E2E_ACAT', 'E2E activity category', 'active')
       RETURNING id`,
      [seedTenantId],
    );
    const activityType = await client.query<{ id: number }>(
      `INSERT INTO reward_config.activity_types (tenant_id, category_id, type_code, name, status)
       VALUES ($1, $2, 'E2E_ATYPE', 'E2E activity type', 'active')
       RETURNING id`,
      [seedTenantId, activityCategory.rows[0].id],
    );

    return {
      ruleSubCategoryId: ruleSubCategory.rows[0].id,
      activityCategoryId: activityCategory.rows[0].id,
      activityTypeId: activityType.rows[0].id,
      seedTenantId,
    };
  });
}

/**
 * A fresh `reward_config.activities` row for one spec's own tenant — created directly for the
 * same reason `seedReferenceData` is (no REST path exists), but per-spec (unlike the reference
 * rows above) because `activities.tenant_id` must be the tenant the campaign under test actually
 * belongs to — `merchant-portal.service.ts`'s scope rule would otherwise never surface it.
 */
export async function createActivity(
  info: DbConnectionInfo,
  args: { tenantId: number; typeId: number; activityCode: string; name: string },
): Promise<number> {
  return withClient(info, async (client) => {
    const result = await client.query<{ id: number }>(
      `INSERT INTO reward_config.activities (tenant_id, type_id, activity_code, name, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [args.tenantId, args.typeId, args.activityCode, args.name],
    );
    return result.rows[0].id;
  });
}

/**
 * `UPDATE reward_portal.portal_users SET role = …` — TC-N6 (`negative-journeys.spec.ts`), the one
 * other place besides `back-end/test/approvals/approvals.e2e-spec.ts`'s own TC-6 that needs to
 * honestly promote a maker to checker *after* a real submission, to reach the self-approval guard
 * for the same user in both roles over time (`SelfApprovalForbiddenError`'s own header,
 * architect ruling on TC-N6, `T-050-e2e-tests.md`).
 *
 * No portal API can do this: `PATCH /users/:id` refuses **any** `role` field unconditionally
 * (`users.service.ts#update`, `ROLE_CHANGE_NOT_PERMITTED`) — not a defect, T-035's own mandatory
 * TC-28 requires exactly that refusal. `approvals.e2e-spec.ts`'s header explains why this is the
 * *honest* way to reach the scenario rather than a shortcut: "built honestly, not by editing
 * `requested_by`" — the row this promotes is a real account that really submitted the campaign
 * under test while still a maker; only the role changes, and only after.
 */
export async function setUserRole(
  info: DbConnectionInfo,
  userId: number,
  role: 'maker' | 'checker' | 'tenant_admin' | 'country_admin' | 'merchant' | 'super_admin',
): Promise<void> {
  await withClient(info, async (client) => {
    // By numeric id, never by matching on `email` — the column is ciphertext
    // (`model-encryption.hooks.ts`, T-016/T-056) and `email_bidx`'s HMAC key lives in an env var
    // this connection has no access to, so no direct-SQL match on email is possible here anyway.
    // The caller resolves `userId` the same way `negative-journeys.spec.ts`'s own TC-N9 already
    // does: `GET /users` as `super_admin` (which decrypts correctly — only `POST /users`'s
    // response has the known, disclosed ciphertext-leak, `utils/scenario.ts`'s header "bug 2"),
    // filtered to the one email this suite itself just created.
    const result = await client.query('UPDATE reward_portal.portal_users SET role = $1 WHERE id = $2', [
      role,
      userId,
    ]);
    if (result.rowCount === 0) {
      throw new Error(`setUserRole: no portal_users row with id ${String(userId)}`);
    }
  });
}

export async function insertEncryptionKey(
  info: DbConnectionInfo,
  args: { kid: string; purpose: 'field' | 'blind_index'; algorithm: string; envVarName: string },
): Promise<void> {
  await withClient(info, async (client) => {
    await client.query(
      `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [args.kid, args.purpose, args.algorithm, `env:${args.envVarName}`],
    );
  });
}

/** Polls `SELECT 1` until the server accepts connections, or the timeout elapses. Testcontainers'
 * own wait strategy already waits for the log line, but the very first connection after that can
 * still race the server's own "start accepting connections" step by a few hundred ms. */
export async function waitForDatabase(info: DbConnectionInfo, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await withClient(info, async (client) => {
        await client.query('SELECT 1');
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Postgres never became reachable: ${String(lastError)}`);
}
