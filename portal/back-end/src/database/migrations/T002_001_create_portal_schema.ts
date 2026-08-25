import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Creates the `reward_portal` schema and the `pgcrypto` extension `gen_random_uuid()`
 * depends on (01-DATABASE.md §2.3 uses it for every UUID primary key). Idempotent —
 * `IF NOT EXISTS` throughout — so a re-run is a no-op, not an error.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query('CREATE SCHEMA IF NOT EXISTS reward_portal;', { type: QueryTypes.RAW });
  await context.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;', { type: QueryTypes.RAW });
}

/**
 * Deliberately does NOT drop the schema here — later migrations create tables inside it,
 * and their own `down()` is what removes those tables. Dropping the schema in this
 * migration's `down()` would make per-migration rollback order-dependent in the wrong
 * direction (T002_002's `down()` would fail if this one already removed the schema it
 * lives in). `pgcrypto` is left in place too — it may be relied on elsewhere, and
 * extensions are effectively global to the database, not owned by one migration.
 */
export async function down(_args: { context: Sequelize }): Promise<void> {
  // no-op — see rationale above
}
