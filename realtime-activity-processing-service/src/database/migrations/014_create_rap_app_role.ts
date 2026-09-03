import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * The least-privilege runtime role this service's own application code connects as (R1,
 * AGENT-PROTOCOL.md). Scoped to `realtime_activity_processing.*` only — `GRANT USAGE` on the
 * schema plus SELECT/INSERT/UPDATE/DELETE on every table currently in it, with
 * `ALTER DEFAULT PRIVILEGES` so a later migration's new table in this schema is covered
 * automatically without a fresh GRANT statement here. Never `GRANT ALL ON DATABASE`, never DDL
 * (`CREATE`/`DROP` on tables — only `USAGE`, no `CREATE`, on the schema itself), never anything
 * outside `realtime_activity_processing` — R1 is the entire reason this migration exists as its
 * own concern, separate from "just create the tables" (002-013). Run last (after every table
 * exists) so `GRANT ... ON ALL TABLES IN SCHEMA` actually covers the full set. Mirrors
 * `promo-code-service/src/database/migrations/007_create_promo_code_app_role.ts` verbatim in
 * shape.
 */
const APP_ROLE = 'rap_app';

/**
 * `DB_APP_PASSWORD` is required at migrate time (not just at app-boot time) because this
 * migration is what actually sets the role's password. Read directly from `process.env` rather
 * than `validateConfig` (used by `migration-connection.ts` for the connection itself) — the
 * migration CLI's own env-loading (`cli/migrate.ts`) has already populated `process.env` by the
 * time any migration's `up()` runs, and re-validating the whole config schema here would be
 * redundant. R8: no default password in a committed file — a missing value fails loudly, never
 * silently falls back to a fixed string.
 */
function requireAppPassword(): string {
  const password = process.env.DB_APP_PASSWORD;
  if (!password) {
    throw new Error(
      'DB_APP_PASSWORD is required to create/alter the rap_app role (R8: no default password ' +
        'in a committed file) — set it in .env.development (or the real environment) before ' +
        'running db:migrate.',
    );
  }
  return password;
}

/**
 * Idempotent — Postgres has no native `CREATE ROLE IF NOT EXISTS`, so existence is checked
 * first via a `DO $$ ... $$` block and the role is altered rather than re-created if it's
 * already there. Required so `migrate → rollback → migrate` (R7) doesn't fail the second time
 * through on "role already exists" — and so re-running `db:migrate` after a password rotation
 * in `.env.development` actually picks up the new value.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
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

  await context.query(`GRANT USAGE ON SCHEMA realtime_activity_processing TO ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
  await context.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA realtime_activity_processing TO ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA realtime_activity_processing
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
}

/**
 * Reverses every grant this migration made, then drops the role itself — proven by the
 * `migrate → rollback → migrate` cycle (R7). Runs before 002-013's own `down()` (Umzug reverts
 * in reverse migration order: 014, 013, ..., 001) — the tables this role was granted on still
 * exist at this point, so the table-level `REVOKE` has something to act on.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA realtime_activity_processing
       REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `REVOKE ALL ON ALL TABLES IN SCHEMA realtime_activity_processing FROM ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(`REVOKE USAGE ON SCHEMA realtime_activity_processing FROM ${APP_ROLE};`, {
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
