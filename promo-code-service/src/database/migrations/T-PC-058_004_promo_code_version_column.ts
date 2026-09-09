import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-PC-059 — `promo_code.promo_code` gains `promo_code_config_version_id` (T-PC-058 Implementation
 * note 5): the audit trail this whole versioning effort exists to provide — "which version was
 * this specific code generated under," queryable directly, not just inferred from the existing
 * value snapshot (`reward_value_type`/`reward_value`/`reward_unit`, unaffected by this task).
 *
 * **Nullable at the DB level, no backfill** — deliberately, per T-PC-058's own note 5: "nullable
 * at the DB level for pre-existing rows, always populated for every new one." Every already-issued
 * code was generated before this column existed and has no version to attribute (its own
 * `reward_value_type`/`reward_value`/`reward_unit` snapshot is untouched and remains the source of
 * truth for what it actually paid out); only `PromoCodeGenerationService` going forward (T-PC-060,
 * outside this migration's scope) is responsible for always populating it on new rows — a DB-level
 * `NOT NULL` would be wrong here, not just premature, since it would have nothing to backfill
 * existing rows with that wouldn't be an invented fact.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE promo_code.promo_code
       ADD COLUMN promo_code_config_version_id uuid NULL
         REFERENCES promo_code.promo_code_config_version(id);`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_promo_code_config_version
       ON promo_code.promo_code (promo_code_config_version_id);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE promo_code.promo_code DROP COLUMN promo_code_config_version_id;`,
    { type: QueryTypes.RAW },
  );
}
