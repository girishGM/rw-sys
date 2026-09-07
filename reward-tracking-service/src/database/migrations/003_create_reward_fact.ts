import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_tracking.reward_fact` — `brain-storm/02-DATA-MODEL.md` §2.1, verbatim. Append-only, one
 * row per reward actually given — the source of truth every ledger row and every counter shard is
 * derived from. `expires_at` is taken VERBATIM from the inbound payload, never recomputed here
 * (R5). Includes the summability-fix columns from day one (§2.2/§2.3, not a later amendment):
 * `reward_kind`, `promo_code_config_id`, `promo_code_config_version_no`.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_tracking.reward_fact (
      id                            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_entry_id                varchar(64)   NOT NULL,
      correlation_id                 varchar(64)   NOT NULL,
      tenant_id                      int           NOT NULL,
      tenant_code                    varchar(20)   NULL,
      country_code                   char(2)       NULL,
      customer_id_encrypted          text          NOT NULL,
      customer_id_hash               varchar(64)   NOT NULL,
      campaign_code                  varchar(50)   NOT NULL,
      tracker_code                   varchar(50)   NULL,
      tracker_component_code         varchar(50)   NULL,
      merchant_code                  varchar(50)   NULL,
      reward_code                    varchar(80)   NOT NULL,
      reward_category                varchar(50)   NOT NULL,
      reward_kind                    varchar(20)   NULL,
      unit_type                      varchar(14)   NULL,
      unit_code                      varchar(10)   NULL,
      reward_value                   decimal(18,4) NOT NULL,
      reward_value_unit               varchar(10)   NOT NULL,
      external_system_code           varchar(50)   NULL,
      external_reference_id          varchar(200)  NULL,
      promo_code_config_id           varchar(64)   NULL,
      promo_code_config_version_no   int           NULL,
      redeemed_at                    timestamptz   NOT NULL,
      expires_at                     timestamptz   NULL,
      reward_lifecycle_status        varchar(20)   NOT NULL DEFAULT 'ACTIVE',
      ingested_at                    timestamptz   NOT NULL DEFAULT now(),
      created_at                     timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT uq_rf_reward_entry UNIQUE (reward_entry_id)
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_rf_customer_campaign_tracker
       ON reward_tracking.reward_fact (tenant_id, customer_id_hash, campaign_code, tracker_code);`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_rf_expiry_watch
       ON reward_tracking.reward_fact (tenant_id, customer_id_hash, expires_at)
       WHERE reward_lifecycle_status = 'ACTIVE' AND expires_at IS NOT NULL;`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_rf_merchant ON reward_tracking.reward_fact (merchant_code)
       WHERE merchant_code IS NOT NULL;`,
    { type: QueryTypes.RAW },
  );
  await context.query(`CREATE INDEX ix_rf_tenant ON reward_tracking.reward_fact (tenant_id);`, {
    type: QueryTypes.RAW,
  });
  await context.query(
    `CREATE INDEX ix_rf_country ON reward_tracking.reward_fact (country_code)
       WHERE country_code IS NOT NULL;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_tracking.reward_fact;', {
    type: QueryTypes.RAW,
  });
}
