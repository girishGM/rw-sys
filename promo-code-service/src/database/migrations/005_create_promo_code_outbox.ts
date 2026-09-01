import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `promo_code_outbox` — transactional outbox for the async (Kafka) path only
 * (01-DATABASE.md §4). The code row and its outbox row are written in the same DB transaction
 * (T-PC-021/T-PC-022); a separate poller publishes and marks `PUBLISHED`. No outbox row is
 * written for a `GRPC`-transport request — the caller is holding the connection open, so
 * there's no delivery gap to bridge.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE promo_code.promo_code_outbox (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      promo_code_id  uuid NOT NULL REFERENCES promo_code.promo_code(id),
      topic          varchar(120) NOT NULL,
      payload        jsonb NOT NULL,
      status         varchar(20) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','PUBLISHED','FAILED')),
      attempts       smallint NOT NULL DEFAULT 0,
      created_at     timestamptz NOT NULL DEFAULT now(),
      published_at   timestamptz NULL
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_promo_code_outbox_pending
       ON promo_code.promo_code_outbox (status, created_at) WHERE status = 'PENDING';`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS promo_code.promo_code_outbox;', {
    type: QueryTypes.RAW,
  });
}
