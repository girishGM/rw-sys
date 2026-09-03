import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { DEMO_FIELD_ENCRYPTION_CONFIG } from './seed-data.constants';

/**
 * T-RAP-003 — seeds `realtime_activity_processing.field_encryption_config`'s one required row
 * (01-DATABASE.md §10): `('global', NULL, 'customerId', true)`.
 *
 * **Deliberately not `ON CONFLICT (scope_level, scope_ref, field_name) DO NOTHING`.** Postgres
 * unique indexes treat two `NULL`s as *distinct*, not equal (confirmed directly against this
 * service's own real Postgres 16 server while implementing this task — a scratch unique index on
 * `(a, b, c)` happily accepted two `('global', NULL, 'customerId')` rows in a row, `ON CONFLICT`
 * and all, because the arbiter index never considered the second row's `NULL` a match for the
 * first's). `uc_field_encryption_config` allows a `NULL` `scope_ref` (it's how `'global'` scope is
 * represented — 01-DATABASE.md §10), so a naive `ON CONFLICT` here would silently violate this
 * task's own idempotency requirement (TC-2) the very first time it ran twice. `INSERT ... SELECT
 * ... WHERE NOT EXISTS`, keyed on the same `IS NULL`-aware comparison, is what actually holds.
 */
export async function seedFieldEncryptionConfig(sequelize: Sequelize): Promise<void> {
  const row = DEMO_FIELD_ENCRYPTION_CONFIG;

  await sequelize.query(
    `INSERT INTO realtime_activity_processing.field_encryption_config
       (scope_level, scope_ref, field_name, is_encrypted, added_by)
     SELECT :scope_level, :scope_ref, :field_name, :is_encrypted, :added_by
     WHERE NOT EXISTS (
       SELECT 1 FROM realtime_activity_processing.field_encryption_config
        WHERE scope_level = :scope_level
          AND scope_ref IS NOT DISTINCT FROM :scope_ref
          AND field_name = :field_name
     )`,
    {
      type: QueryTypes.RAW,
      replacements: {
        scope_level: row.scope_level,
        scope_ref: row.scope_ref,
        field_name: row.field_name,
        is_encrypted: row.is_encrypted,
        added_by: row.added_by,
      },
    },
  );
}
