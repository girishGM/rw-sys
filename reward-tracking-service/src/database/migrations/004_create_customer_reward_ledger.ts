import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_tracking.customer_reward_ledger` — `brain-storm/02-DATA-MODEL.md` §3.1, verbatim.
 * Grain: one row per (customer, campaign, tracker, tracker component, reward category/kind/unit)
 * — no time bucket. `reward_kind` is part of `uq_crl` alongside `reward_category` (TC-3): if the
 * same tracker/component is ever bound to a `FIXED_AMOUNT` reward in one version and a
 * `PERCENTAGE` one in a later version, they land in separate rows, never merging their
 * (incompatible) `total_reward_value` together (§2.2).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_tracking.customer_reward_ledger (
      id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id               int           NOT NULL,
      customer_id_hash        varchar(64)   NOT NULL,
      campaign_code           varchar(50)   NOT NULL,
      tracker_code            varchar(50)   NOT NULL,
      tracker_component_code  varchar(50)   NOT NULL,
      reward_category         varchar(50)   NOT NULL,
      reward_kind             varchar(20)   NULL,
      unit_type                varchar(14)   NULL,
      unit_code                varchar(10)   NULL,
      total_reward_value      decimal(18,4) NOT NULL DEFAULT 0,
      total_reward_count      int           NOT NULL DEFAULT 0,
      first_earned_at         timestamptz   NOT NULL,
      last_earned_at          timestamptz   NOT NULL,
      updated_at               timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT uq_crl UNIQUE (tenant_id, customer_id_hash, campaign_code, tracker_code,
                                tracker_component_code, reward_category, reward_kind, unit_type,
                                unit_code)
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_crl_customer ON reward_tracking.customer_reward_ledger
       (tenant_id, customer_id_hash);`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_crl_tracker ON reward_tracking.customer_reward_ledger
       (tenant_id, customer_id_hash, tracker_code);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_tracking.customer_reward_ledger;', {
    type: QueryTypes.RAW,
  });
}
