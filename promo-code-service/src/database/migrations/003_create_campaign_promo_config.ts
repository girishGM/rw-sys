import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `campaign_promo_config` — which recipe is attached to which campaign/tracker/component
 * (01-DATABASE.md §2). Copied verbatim from the design doc. `bind_ref_id` is deliberately NOT
 * a foreign key (§2's note: this service's database must never depend on the portal's schema
 * being reachable) — do not add one. `promo_code_config_id`'s `ON DELETE` is deliberately left
 * as the Postgres default (`NO ACTION`), never `CASCADE` (§2's note, AGENT-PROTOCOL.md task
 * implementation note 3): a config with live bindings must fail loudly on an attempted hard
 * delete, not silently orphan the binding.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE promo_code.campaign_promo_config (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      promo_code_config_id  uuid NOT NULL REFERENCES promo_code.promo_code_config(id),
      tenant_id             uuid NOT NULL,
      bind_level            varchar(20) NOT NULL
                               CHECK (bind_level IN ('CAMPAIGN','TRACKER','COMPONENT')),
      bind_ref_id           uuid NOT NULL,
      status                varchar(20) NOT NULL DEFAULT 'ACTIVE'
                               CHECK (status IN ('ACTIVE','INACTIVE')),
      bound_by              uuid NOT NULL,
      bound_at              timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_campaign_promo_config_active
       ON promo_code.campaign_promo_config (tenant_id, bind_level, bind_ref_id)
       WHERE status = 'ACTIVE';`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_campaign_promo_config_lookup
       ON promo_code.campaign_promo_config (bind_level, bind_ref_id);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS promo_code.campaign_promo_config;', {
    type: QueryTypes.RAW,
  });
}
