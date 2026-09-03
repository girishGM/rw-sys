import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { DEMO_SERVICE_CONFIGS } from './seed-data.constants';

/**
 * T-RAP-003 — seeds the four global `realtime_activity_processing.service_config` rows
 * 01-DATABASE.md §11 names explicitly.
 *
 * Same `INSERT ... SELECT ... WHERE NOT EXISTS` pattern as
 * `001_seed_field_encryption_config.ts` for the same reason: `uq_service_config_key_scope`
 * covers a nullable `scope_ref` (`NULL` for every `'global'` row seeded here), and Postgres does
 * not consider two `NULL`s equal for either a unique index/constraint's own enforcement or an
 * `ON CONFLICT` arbiter match — a plain `ON CONFLICT ... DO NOTHING` would insert a fresh
 * duplicate row every single run instead of the no-op TC-2 requires. `IS NOT DISTINCT FROM` is
 * the one comparison operator that treats `NULL = NULL` as true, so it's what this idempotency
 * check needs instead of `=`.
 */
export async function seedServiceConfig(sequelize: Sequelize): Promise<void> {
  for (const row of DEMO_SERVICE_CONFIGS) {
    await sequelize.query(
      `INSERT INTO realtime_activity_processing.service_config
         (config_key, config_value, scope_level, scope_ref, description)
       SELECT :config_key, :config_value, :scope_level, :scope_ref, :description
       WHERE NOT EXISTS (
         SELECT 1 FROM realtime_activity_processing.service_config
          WHERE config_key = :config_key
            AND scope_level = :scope_level
            AND scope_ref IS NOT DISTINCT FROM :scope_ref
       )`,
      {
        type: QueryTypes.RAW,
        replacements: {
          config_key: row.config_key,
          config_value: row.config_value,
          scope_level: row.scope_level,
          scope_ref: row.scope_ref,
          description: row.description,
        },
      },
    );
  }
}
