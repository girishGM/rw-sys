import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-PC-052 — every portal-sourced id column this schema stores (`tenant_id`, `merchant_id`,
 * `bind_ref_id`, `bound_by`, `created_by`, `updated_by`, `changed_by`) was typed `uuid` from
 * `01-DATABASE.md`'s original design, but `project-plan` T-170's own investigation proved,
 * executably, that the portal's real ids for every one of these (`tenants.id`,
 * `tenant_campaigns.id`, `tracker_components.id`, `admin_users.id`) are plain Postgres `int`,
 * never UUIDs. `01-DATABASE.md` §2 already argues `bind_ref_id` is "an external reference...
 * deliberately not a foreign key" — a description of an opaque string, not a reason to constrain
 * it to UUID format. This migration widens the typing to match that stated intent and the
 * portal's actual reality: `varchar(64)`, not `uuid`.
 *
 * A new migration, never an edit to 002/003/004/006 — those are already applied in every
 * environment this service has run in (task file implementation note 1; same convention as the
 * portal's own `T121_002`). `uuid → varchar` widen is safe and lossless: every existing UUID
 * value already prints as a valid string, so no data transformation is needed and existing rows
 * keep their current (UUID-shaped) values unchanged (TC-1, TC-6).
 *
 * `varchar(64)`, not `text`/unbounded — generous enough for any realistic portal id (an `int`
 * printed decimal is at most 10 characters) while still bounding storage/index size, matching the
 * existing `customer_id varchar(120)` precedent's spirit of "opaque external reference, bounded,
 * not unlimited" (implementation note 3).
 *
 * The 7 distinct portal-sourced id column *names* this task's Objective lists appear across 10
 * physical (table, column) pairs — `tenant_id` and `merchant_id` each recur on more than one
 * table — so this migration issues 10 `ALTER COLUMN ... TYPE varchar(64)` statements, one per
 * physical column, exactly as implementation note 1 enumerates them. `grpc_service_identity`'s
 * own `created_by` (migration 008) is asserted by an internal admin tool, not portal-sourced —
 * confirmed out of scope by the task file, left `uuid`.
 */
const WIDENED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'promo_code_config', column: 'tenant_id' },
  { table: 'promo_code_config', column: 'merchant_id' },
  { table: 'promo_code_config', column: 'created_by' },
  { table: 'promo_code_config', column: 'updated_by' },
  { table: 'campaign_promo_config', column: 'tenant_id' },
  { table: 'campaign_promo_config', column: 'bind_ref_id' },
  { table: 'campaign_promo_config', column: 'bound_by' },
  { table: 'promo_code', column: 'tenant_id' },
  { table: 'promo_code', column: 'merchant_id' },
  { table: 'promo_code_config_audit', column: 'changed_by' },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  for (const { table, column } of WIDENED_COLUMNS) {
    await context.query(
      `ALTER TABLE promo_code.${table} ALTER COLUMN ${column} TYPE varchar(64);`,
      { type: QueryTypes.RAW },
    );
  }
}

/**
 * Narrows back to `uuid`. **Not safe in general** — an arbitrary varchar is not a valid UUID —
 * but is safe here specifically because nothing between `up()` and a same-session `down()` can
 * have inserted a non-UUID value yet: T-PC-053/054/055 haven't shipped the relaxed validators
 * that would let one in (task file implementation note 2). Cast explicitly (`USING
 * <col>::uuid`) so a genuine non-UUID value present at rollback time fails loudly rather than
 * silently truncating.
 *
 * If this migration is rolled back *after* T-PC-053+ have shipped and real non-UUID data
 * exists, that data must be cleaned up or re-encoded first — this `down()` does not attempt
 * that for the caller (task file "Rollback" section).
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  for (const { table, column } of WIDENED_COLUMNS) {
    await context.query(
      `ALTER TABLE promo_code.${table} ALTER COLUMN ${column} TYPE uuid USING ${column}::uuid;`,
      { type: QueryTypes.RAW },
    );
  }
}
