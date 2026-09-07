import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_tracking.customer_reward_balance` — `brain-storm/02-DATA-MODEL.md` §6.1, verbatim. A
 * separate wallet-style view from `reward_fact` — expiry is inherently per-instance (two otherwise
 * identical rewards to the same customer can carry different `expires_at` values), so it can never
 * be folded into `customer_reward_ledger`'s aggregated row. Includes `reward_kind`,
 * `promo_code_config_id`, `promo_code_config_version_no` from day one (§2.3).
 *
 * `reward_fact_id` is a same-schema foreign key only (R2) — `reward_fact` lives in this same
 * `reward_tracking` schema, never a cross-schema reference.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_tracking.customer_reward_balance (
      id                            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_fact_id                 uuid          NOT NULL REFERENCES reward_tracking.reward_fact (id),
      tenant_id                      int           NOT NULL,
      customer_id_hash               varchar(64)   NOT NULL,
      campaign_code                  varchar(50)   NOT NULL,
      reward_category                varchar(50)   NOT NULL,
      unit_type                      varchar(14)   NULL,
      unit_code                      varchar(10)   NULL,
      reward_code                    varchar(80)   NULL,
      reward_kind                    varchar(20)   NULL,
      external_reference_id          varchar(200)  NULL,
      promo_code_config_id           varchar(64)   NULL,
      promo_code_config_version_no   int           NULL,
      issued_value                   decimal(18,4) NOT NULL,
      status                         varchar(20)   NOT NULL DEFAULT 'ACTIVE',
      issued_at                      timestamptz   NOT NULL,
      expires_at                     timestamptz   NULL,
      used_at                        timestamptz   NULL,
      updated_at                     timestamptz   NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_crb_expiring ON reward_tracking.customer_reward_balance
       (tenant_id, customer_id_hash, expires_at)
       WHERE status = 'ACTIVE' AND expires_at IS NOT NULL;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_tracking.customer_reward_balance;', {
    type: QueryTypes.RAW,
  });
}
