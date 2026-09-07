/**
 * T-RR-036. `reward_redemption.notification_log` (`01-DATABASE.md` §8) — logged-not-sent
 * push-notification intents. Same small-`Pool`-owning-repository shape every other
 * repository in this service already establishes (`RewardTrackingOutboxRepository`,
 * T-RR-034, confirmed by direct read), with one deliberate difference: `create()`'s own
 * transaction handle is **optional**, not required. `RewardTrackingOutboxRepository.enqueue()`
 * always requires a caller-supplied `PoolClient` because it is only ever called from inside the
 * redemption pipeline's own open transaction; `notifyIfConfigured()` (`notification.service.ts`)
 * must also work when called completely standalone (every one of this task's own test cases
 * bar TC-7 does exactly that) — implementation note 4's own "must accept an **optional**
 * externally-supplied transaction handle" wording, not "must require one".
 *
 * `customer_id_hash`, never `customer_id_encrypted` or plaintext, anywhere in this file (R8,
 * `01-DATABASE.md` §8's own column choice) — this repository only ever receives an
 * already-hashed string from its caller and writes it through unchanged; it never touches
 * `EncryptionService` at all.
 */
import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import type { Config } from '@/config/config.schema';
import type { NotificationLogRow } from '@/database/models/notification-log.model';

/** The one channel this service models today (`01-DATABASE.md` §8's own comment, TC-5) — typed as
 * a literal union of one so a future second channel is a compile-time-visible addition, not a
 * silent string. */
export type NotificationChannel = 'PUSH';

export interface NotificationLogInsert {
  rewardEntryId: string;
  tenantId: number;
  customerIdHash: string;
  campaignCode: string;
  rewardCode: string;
  channel: NotificationChannel;
  wouldBePayload: Record<string, unknown>;
}

/** Either a plain `Pool` (this repository's own standalone-mode connection) or a caller-supplied
 * `PoolClient` already inside an open transaction — both expose the same `query()` shape this
 * repository actually calls. */
type Queryable = Pick<Pool | PoolClient, 'query'>;

const INSERT_SQL = `
  INSERT INTO reward_redemption.notification_log
    (reward_entry_id, tenant_id, customer_id_hash, campaign_code, reward_code, channel, would_be_payload)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING *
`;

@Injectable()
export class NotificationLogRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  /** Second constructor parameter exists solely so a test can substitute a real (test-owned) or
   * fake `Pool` — same `@Optional()` idiom every repository in this service already uses. */
  constructor(config: ConfigService<Config, true>, @Optional() pool?: Pool) {
    this.pool =
      pool ??
      new Pool({
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        user: config.get('DB_APP_USERNAME', { infer: true }),
        password: config.get('DB_APP_PASSWORD', { infer: true }),
        ssl: config.get('DB_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      });
  }

  /**
   * TC-1/TC-4/TC-5/TC-7/TC-8: writes one `notification_log` row. Uses the caller-supplied
   * `client` when given (participates in that transaction, commits/rolls back with it — TC-7);
   * falls back to this repository's own standalone `Pool` otherwise. Never opens or manages a
   * transaction itself either way — that's always the caller's concern.
   */
  async create(row: NotificationLogInsert, client?: PoolClient): Promise<NotificationLogRow> {
    const executor: Queryable = client ?? this.pool;
    const result = await executor.query<NotificationLogRow>(INSERT_SQL, [
      row.rewardEntryId,
      row.tenantId,
      row.customerIdHash,
      row.campaignCode,
      row.rewardCode,
      row.channel,
      JSON.stringify(row.wouldBePayload),
    ]);
    const inserted = result.rows[0];
    if (inserted === undefined) {
      throw new Error(
        `notification_log insert for reward_entry ${row.rewardEntryId} returned no row ` +
          '(structurally unreachable — a plain INSERT with no ON CONFLICT clause).',
      );
    }
    return inserted;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
