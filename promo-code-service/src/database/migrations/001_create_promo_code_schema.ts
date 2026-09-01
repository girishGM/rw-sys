import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Creates the `promo_code` schema and the `pgcrypto` extension `gen_random_uuid()` depends on
 * (01-DATABASE.md — every table's `id` primary key uses it). Idempotent — `IF NOT EXISTS`
 * throughout — so a re-run is a no-op, not an error (R6: `migrate → rollback → migrate`).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query('CREATE SCHEMA IF NOT EXISTS promo_code;', { type: QueryTypes.RAW });
  await context.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;', { type: QueryTypes.RAW });
}

/**
 * Deliberately does NOT drop the schema here — same reasoning as the portal's own equivalent
 * migration (`T002_001_create_portal_schema.ts`): later migrations create tables inside it, and
 * Umzug's own `SequelizeStorage` bookkeeping table (`promo_code.migrations`) also lives inside
 * it and is *not* one of this task's own migrations, so it can't be dropped from within a
 * migration's own `down()` — the moment the schema disappears, Umzug can no longer record that
 * `001` itself was successfully reverted (proven live: this exact ordering was tried first and
 * failed with `schema "promo_code" does not exist` while Umzug tried to write its own
 * bookkeeping row immediately afterward). The actual full teardown this task's own DoD needs
 * (verification step 2, "`npm run db:rollback -- --all` → All 5 tables + schema + role
 * removed") is instead done by the CLI itself (`cli/migrate.ts`'s `--all` branch), as an
 * explicit step *after* Umzug's own `down({ to: 0 })` has finished recording every migration —
 * see that file's own comment. `pgcrypto` is left installed either way: it's effectively global
 * to the database, not owned by this one schema/migration, and other schemas
 * (`reward_config`/`reward_portal`) may already rely on it independently of this service.
 */
export async function down(_args: { context: Sequelize }): Promise<void> {
  // no-op — see rationale above
}
