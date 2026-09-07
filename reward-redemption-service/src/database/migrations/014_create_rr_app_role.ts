import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * The least-privilege runtime role this service's own application code connects as (R1,
 * AGENT-PROTOCOL.md). Scoped to `reward_redemption.*` only — `GRANT USAGE` on the schema plus
 * SELECT/INSERT/UPDATE/DELETE on every table currently in it, with `ALTER DEFAULT PRIVILEGES` so
 * a later migration's new table in this schema is covered automatically without a fresh GRANT
 * statement here. Never `GRANT ALL ON DATABASE`, never DDL (`CREATE`/`DROP` on tables — only
 * `USAGE`, no `CREATE`, on the schema itself), never anything outside `reward_redemption` — R1 is
 * the entire reason this migration exists as its own concern, separate from "just create the
 * tables" (002-013). Run last (after every table exists) so `GRANT ... ON ALL TABLES IN SCHEMA`
 * actually covers the full set. Mirrors RAP's own real, shipped
 * `realtime-activity-processing-service/src/database/migrations/014_create_rap_app_role.ts` line
 * for line in structure (T-RR-003 note 6), not reinvented.
 */
const APP_ROLE = 'rr_app';

/**
 * `DB_APP_PASSWORD` is required at migrate time (not just at app-boot time) because this
 * migration is what actually sets the role's password. Read directly from `process.env` rather
 * than a validated config schema — this task's own `migration-connection.ts` (T-RR-001) already
 * establishes the same "read `DB_*` directly from `process.env`" convention for this plan, since
 * `src/config/config.schema.ts` (T-RR-004) doesn't exist yet and isn't a dependency of this task.
 * R1/note 6: no default password in a committed file — a missing value fails loudly, never
 * silently falls back to a fixed string (TC-8).
 */
function requireAppPassword(): string {
  const password = process.env.DB_APP_PASSWORD;
  if (!password) {
    throw new Error(
      'DB_APP_PASSWORD is required to create/alter the rr_app role (R1: no default password in ' +
        'a committed file) — set it in .env.development (or the real environment) before ' +
        'running db:migrate.',
    );
  }
  return password;
}

/**
 * Idempotent — Postgres has no native `CREATE ROLE IF NOT EXISTS`, so existence is checked first
 * via a `DO $$ ... $$` block and the role is altered rather than re-created if it's already
 * there. Required so `migrate → rollback → migrate` (R4/TC-7) doesn't fail the second time
 * through on "role already exists", and so re-running `db:migrate` after a password rotation in
 * `.env.development` actually picks up the new value. The password is never string-concatenated
 * into the SQL text — `context.escape` produces a properly quoted/escaped SQL literal, avoiding
 * both a syntax-injection risk and a query-log line containing the raw value pre-escaping (note
 * 6's "never string-concatenating the password into SQL text" instruction).
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

  await context.query(`GRANT USAGE ON SCHEMA reward_redemption TO ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
  await context.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reward_redemption TO ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_redemption
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
}

/**
 * Reverses every grant this migration made, then drops the role itself — proven by the
 * `migrate → rollback → migrate` cycle (R4/TC-7). Umzug reverts in reverse migration order (014,
 * 013, ..., 001), so this runs before 013's own `down()` — the tables this role was granted on
 * still exist at this point, so the table-level `REVOKE` has something to act on, and by fully
 * revoking every grant (including the schema-level `USAGE`) before `DROP ROLE`, this satisfies
 * T-RR-003 note 7's requirement without depending on 013-004's own `down()` to release anything:
 * Postgres refuses to drop a role that still owns objects or holds active grants, and this
 * `down()` releases all of them itself, entirely within its own transaction, before the tables it
 * was granted on are ever dropped by an earlier-numbered migration's `down()`.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_redemption
       REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(`REVOKE ALL ON ALL TABLES IN SCHEMA reward_redemption FROM ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
  await context.query(`REVOKE USAGE ON SCHEMA reward_redemption FROM ${APP_ROLE};`, {
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
