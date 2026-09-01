import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `promo_code` — the issuance ledger, every code this service has ever generated
 * (01-DATABASE.md §3). Copied verbatim. `reward_value_type`/`reward_value`/`reward_unit` are a
 * snapshot copied from the config at issuance time, not a join — see §3's note. `code` is
 * globally unique (not scoped per config); `correlation_id` is the idempotency key a redelivered
 * Kafka message or retried gRPC call relies on (§3's note, `02-KAFKA-CONTRACTS.md` §4).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE promo_code.promo_code (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      promo_code_config_id     uuid NOT NULL REFERENCES promo_code.promo_code_config(id),
      campaign_promo_config_id uuid NULL REFERENCES promo_code.campaign_promo_config(id),
      code                     varchar(64) NOT NULL,
      customer_id              varchar(120) NOT NULL,
      tenant_id                uuid NOT NULL,
      merchant_id              uuid NULL,
      reward_value_type        varchar(20) NOT NULL,
      reward_value             decimal(18,4) NOT NULL,
      reward_unit              varchar(10) NOT NULL,
      status                   varchar(20) NOT NULL DEFAULT 'ISSUED'
                                  CHECK (status IN ('ISSUED','REDEEMED','EXPIRED','CANCELLED')),
      correlation_id           uuid NOT NULL,
      transport                varchar(10) NOT NULL CHECK (transport IN ('KAFKA','GRPC')),
      issued_at                timestamptz NOT NULL DEFAULT now(),
      expires_at               timestamptz NULL,
      redeemed_at              timestamptz NULL,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query('CREATE UNIQUE INDEX uc_promo_code_code ON promo_code.promo_code (code);', {
    type: QueryTypes.RAW,
  });
  await context.query(
    'CREATE UNIQUE INDEX uc_promo_code_correlation ON promo_code.promo_code (correlation_id);',
    { type: QueryTypes.RAW },
  );
  await context.query(
    'CREATE INDEX ix_promo_code_customer ON promo_code.promo_code (tenant_id, customer_id);',
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS promo_code.promo_code;', { type: QueryTypes.RAW });
}
