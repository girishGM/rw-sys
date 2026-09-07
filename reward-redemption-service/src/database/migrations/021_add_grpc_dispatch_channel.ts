import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-062. Adds `grpc_enabled` to `reward_redemption.dispatch_channel_config` (migration `006`)
 * — the third leg of the Kafka/REST/gRPC trio this table now routes `reward.redemption.completed.v1`
 * dispatch across, mirroring `019_add_kafka_promo_code_channel.ts`'s own precedent for the sibling
 * `promo_code_channel_config` table (confirmed by direct read of that migration's own header).
 * `'GRPC'` itself needs no DDL change to become a legal `primary_channel`/`fallback_channel` value:
 * both columns are a plain `varchar(10)` with no `CHECK` constraint (migration `006`'s own DDL —
 * confirmed by direct read, the enum is enforced at the TypeScript level only, via `DispatchChannel`,
 * widened by this task to `'KAFKA' | 'REST' | 'GRPC'`), and `'GRPC'` (4 chars) fits the existing
 * column width unchanged.
 *
 * `DEFAULT false` reproduces every pre-existing row's actual behavior exactly — no row anywhere
 * (including the seeded `GLOBAL` row) opts into gRPC until an operator explicitly flips it, the same
 * "adding a column must never silently change an existing campaign's resolved channel" discipline
 * `019`'s own header states for `kafka_enabled`.
 *
 * Numbered `021`, not the task file's own suggested `016` — `016`/`017` were already taken
 * (`016_seed_campaign_config_ttl.ts`, and `017` is a deliberately skipped/reserved number per
 * `020`'s own header) and `018`/`019`/`020` are T-RR-080/T-RR-081/T-RR-063's own migrations —
 * `021` is simply the next free number in this directory's own strictly-increasing,
 * lexicographically-sorted sequence (`umzug.ts`'s own glob).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.dispatch_channel_config
       ADD COLUMN grpc_enabled boolean NOT NULL DEFAULT false;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.dispatch_channel_config DROP COLUMN IF EXISTS grpc_enabled;`,
    { type: QueryTypes.RAW },
  );
}
