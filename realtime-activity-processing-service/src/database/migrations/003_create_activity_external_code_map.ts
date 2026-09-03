import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `activity_external_code_map` — local, indexed mirror of the (portal-owned, not-yet-filed —
 * `04-CACHE-INVALIDATION.md` §4 / R0) `reward_portal.activity_external_codes` mapping,
 * 01-DATABASE.md §2. One `external_code` maps to exactly one `activity_code` per tenant.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.activity_external_code_map (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         int NOT NULL,
      external_code     varchar(50) NOT NULL,
      activity_code     varchar(50) NOT NULL,
      fetched_at        timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_activity_external_code_map ON realtime_activity_processing.activity_external_code_map (tenant_id, external_code);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    'DROP TABLE IF EXISTS realtime_activity_processing.activity_external_code_map;',
    { type: QueryTypes.RAW },
  );
}
