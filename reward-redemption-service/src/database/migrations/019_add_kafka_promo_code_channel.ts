import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-081. Adds `kafka_enabled` to `reward_redemption.promo_code_channel_config` (migration
 * `018`, T-RR-080) — the third leg of the REST/gRPC/Kafka trio this table now routes a redemption's
 * synchronous outbound call to promo-code-service across. `'KAFKA'` itself needs no DDL change to
 * become a legal `primary_channel`/`fallback_channel` value: both columns are a plain
 * `varchar(10)` with no `CHECK` constraint (migration `018`'s own header — the enum is enforced at
 * the TypeScript level only, via `PromoCodeChannel`, extended by this task to
 * `'REST' | 'GRPC' | 'KAFKA'`), and `'KAFKA'` (5 chars) fits the existing column width unchanged.
 *
 * `DEFAULT false` reproduces every pre-existing row's actual behavior exactly — no row anywhere
 * (including the seeded `GLOBAL` row) opts into Kafka until an operator explicitly flips it, the
 * same "adding a column must never silently change an existing campaign's resolved channel"
 * discipline migration `018` itself established for `grpc_enabled`.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.promo_code_channel_config
       ADD COLUMN kafka_enabled boolean NOT NULL DEFAULT false;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.promo_code_channel_config DROP COLUMN IF EXISTS kafka_enabled;`,
    { type: QueryTypes.RAW },
  );
}
