import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Creates the `reward_tracking` schema, the `pgcrypto` extension `gen_random_uuid()` depends on
 * (every table's `id` primary key below uses it), and the least-privilege `reward_tracking_app`
 * runtime role (R2, `AGENT-PROTOCOL.md`) — combined into one migration, per this task's own
 * "Files owned" list (`001_create_schema_and_role.ts`), unlike the two-migration split
 * (`001_create_schema` + a later `NNN_create_<x>_app_role`) every sibling service uses.
 *
 * This still gets the ordering right: `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_tracking GRANT
 * ... TO reward_tracking_app`, run here in 001 by the same migration role that will go on to
 * `CREATE TABLE` every table in migrations 002-008, means every one of those later tables is
 * automatically covered by this grant the moment it's created — Postgres applies default
 * privileges to objects a role creates *after* the `ALTER DEFAULT PRIVILEGES` statement runs, not
 * only to objects that already existed. The explicit `GRANT ... ON ALL TABLES IN SCHEMA` below is
 * a no-op today (no tables exist yet) but is included anyway for symmetry with every sibling
 * service's own role migration, and as a harmless safety net if this migration is ever re-run
 * against a schema that already has tables.
 *
 * Idempotent throughout (`IF NOT EXISTS` / a `DO $$ ... $$` existence check for the role) — a
 * re-run is a no-op, not an error (R11: `migrate → rollback → migrate`).
 */
const APP_ROLE = 'reward_tracking_app';

/**
 * `DB_APP_PASSWORD` is required at migrate time (not just at app-boot time) because this
 * migration is what actually sets the role's password. Read directly from `process.env` rather
 * than `validateConfig` (used by `migration-connection.ts` for the connection itself) — the
 * migration CLI's own env-loading (`cli/migrate.ts`) has already populated `process.env` by the
 * time any migration's `up()` runs, and re-validating the whole config schema here would be
 * redundant. R12: no default password in a committed file — a missing value fails loudly, never
 * silently falls back to a fixed string.
 */
function requireAppPassword(): string {
  const password = process.env.DB_APP_PASSWORD;
  if (!password) {
    throw new Error(
      'DB_APP_PASSWORD is required to create/alter the reward_tracking_app role (R12, ' +
        'AGENT-PROTOCOL.md: no default password in a committed file) — set it in ' +
        '.env.development (or the real environment) before running db:migrate.',
    );
  }
  return password;
}

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query('CREATE SCHEMA IF NOT EXISTS reward_tracking;', { type: QueryTypes.RAW });
  await context.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;', { type: QueryTypes.RAW });

  const password = requireAppPassword();
  const escapedPassword = context.escape(password);

  await context.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
         CREATE ROLE ${APP_ROLE} LOGIN PASSWORD ${escapedPassword};
       ELSE
         ALTER ROLE ${APP_ROLE} LOGIN PASSWORD ${escapedPassword};
       END IF;
     END
     $$;`,
    { type: QueryTypes.RAW },
  );

  await context.query(`GRANT USAGE ON SCHEMA reward_tracking TO ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
  await context.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reward_tracking TO ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_tracking
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
}

/**
 * Reverses the role's grants and drops the role, but deliberately does NOT drop the schema
 * itself here — Umzug's own `SequelizeStorage` bookkeeping table (`reward_tracking.migrations`)
 * lives inside the schema this migration created and is *not* one of this task's own migrations,
 * so it can't be dropped from within a migration's own `down()` — the moment the schema
 * disappears, Umzug can no longer record that `001` itself was successfully reverted. The actual
 * full teardown this task's own DoD needs (`npm run db:rollback -- --all`) is instead done by the
 * CLI itself (`cli/migrate.ts`'s `--all` branch), as an explicit step *after* Umzug's own
 * `down({ to: 0 })` has finished recording every migration (mirrors every sibling service's own
 * `001_create_schema`/role-migration split). `pgcrypto` is left installed either way — it's
 * effectively global to the database, not owned by this one schema/migration.
 *
 * By the time this runs (last, since Umzug reverts in reverse order: 008, 007, ..., 001), every
 * table this role was granted on has already been dropped by its own migration's `down()` — the
 * `REVOKE`/`ALTER DEFAULT PRIVILEGES` statements below are harmless no-ops against an
 * already-empty schema, included anyway so the role's grants are explicitly torn down rather than
 * left implicit.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_tracking
       REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(`REVOKE ALL ON ALL TABLES IN SCHEMA reward_tracking FROM ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
  await context.query(`REVOKE USAGE ON SCHEMA reward_tracking FROM ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });

  await context.query(
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
         DROP ROLE ${APP_ROLE};
       END IF;
     END
     $$;`,
    { type: QueryTypes.RAW },
  );
}
