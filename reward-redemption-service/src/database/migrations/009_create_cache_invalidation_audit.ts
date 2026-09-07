import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `cache_invalidation_audit` — who invalidated what, when (`01-DATABASE.md` §11). Written by
 * T-RR-007's generic cache-invalidation endpoint, one row per invocation; `cache_key = NULL`
 * means the request invalidated everything.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.cache_invalidation_audit (
      id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      cache_key    varchar(100) NULL,
      invoked_by   varchar(120) NOT NULL,
      invoked_at   timestamptz  NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.cache_invalidation_audit;', {
    type: QueryTypes.RAW,
  });
}
