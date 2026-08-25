import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds `reward_config.rbac_cache_config` — gap G7, implementation note 4: a global
 * `rbac_ttl_seconds` and a per-role `rbac_version:<role>` counter for all six roles. T-015's
 * RBAC cache reads the TTL and bumps the relevant `rbac_version:<role>` row whenever that
 * role's permissions change, invalidating every cached bootstrap for that role at once.
 *
 * Idempotent via `ON CONFLICT (config_key) DO NOTHING`
 * (`rbac_cache_config_config_key_key UNIQUE (config_key)`, confirmed live).
 */

const ROLES = [
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
] as const;

export const RBAC_CACHE_CONFIG: { key: string; value: string }[] = [
  { key: 'rbac_ttl_seconds', value: '300' },
  ...ROLES.map((role) => ({ key: `rbac_version:${role}`, value: '1' })),
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of RBAC_CACHE_CONFIG) {
      await context.query(
        `INSERT INTO reward_config.rbac_cache_config (config_key, config_value)
         VALUES (:key, :value)
         ON CONFLICT (config_key) DO NOTHING;`,
        { type: QueryTypes.INSERT, transaction: t, replacements: row },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Deletes exactly the rows this migration inserted, matched by `config_key`. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of RBAC_CACHE_CONFIG) {
      await context.query(`DELETE FROM reward_config.rbac_cache_config WHERE config_key = :key;`, {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { key: row.key },
      });
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
