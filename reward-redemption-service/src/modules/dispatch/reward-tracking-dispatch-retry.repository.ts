/**
 * T-RR-035. `reward_redemption.reward_tracking_dispatch_retry` (`01-DATABASE.md` §7) — tier 3,
 * the last-resort fallback table once both the Kafka publish and the immediate REST attempt have
 * failed for a `reward_tracking_dispatch_outbox` row, identical role to RAP's own
 * `reward_dispatch_retry`/`reward-dispatch-retry.repository.ts` (confirmed by direct read).
 *
 * `payload` carries the same `RewardTrackingDispatchPayload` shape the outbox row itself holds
 * (`customerIdEncrypted`, never a decrypted `customerId`, R8) — `RewardTrackingDispatchRetryWorker`
 * decrypts it fresh at the point of each retry attempt, never earlier, never persisting the
 * plaintext form anywhere (same convention `reward-tracking-outbox.repository.ts`'s own header
 * documents for the outbox table).
 *
 * Unlike RAP's own three-state table (`'pending' | 'resolved' | 'exhausted'`),
 * `01-DATABASE.md` §7's own DDL comment for this table names only two values —
 * `'pending' | 'exhausted'` — so a successful retry **deletes** the row outright (`markDelivered`)
 * rather than flipping it to a third, undocumented status value; `01-DATABASE.md` §7 is the
 * design doc and it wins (`AGENT-PROTOCOL.md` §3) over inventing a value it doesn't list.
 *
 * Reuses this module's own small `pg.Pool` convention (`reward-tracking-outbox.repository.ts`),
 * not a redundant second connection pool, for the same "best-effort, non-transactional dispatch
 * concern" reasoning that file's own header gives.
 */
import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { RewardTrackingDispatchRetryRow } from '@/database/models/reward-tracking-dispatch-retry.model';
import type { RewardTrackingDispatchPayload } from './reward-tracking-outbox.repository';

export interface CreateRetryRowInput {
  rewardEntryId: string;
  payload: RewardTrackingDispatchPayload;
  lastError: string;
}

/** The scope-resolution fields `RewardTrackingDispatchRetryWorker` needs to re-resolve
 * `dispatch_channel_config` at retry time (TC-9: "reflects the new config, not the stale original
 * resolution") — read off the *entry* row via a join, the same `OutboxPendingRow` convention
 * (`reward-tracking-outbox.repository.ts`), never off `payload` itself. */
export interface DueRetryRow {
  id: string;
  rewardEntryId: string;
  payload: RewardTrackingDispatchPayload;
  attempts: number;
  nextAttemptAt: Date;
  status: 'pending' | 'exhausted';
  lastError: string | null;
  rewardCode: string;
  trackerCode: string;
  campaignCode: string;
  tenantId: number;
}

interface DueRetryRowRaw {
  id: string;
  reward_entry_id: string;
  payload: RewardTrackingDispatchPayload;
  attempts: number;
  next_attempt_at: Date;
  status: 'pending' | 'exhausted';
  last_error: string | null;
  reward_code: string;
  tracker_code: string;
  campaign_code: string;
  tenant_id: number;
}

const CREATE_SQL = `
  INSERT INTO reward_redemption.reward_tracking_dispatch_retry (reward_entry_id, payload, last_error)
  VALUES ($1, $2, $3)
  RETURNING *
`;

/** `01-DATABASE.md` §7's own column order (`next_attempt_at`), no dedicated partial index yet
 * (out of this task's own migration-owning scope, R3) — a full scan of this table is acceptable
 * at this project's current scale; adding an index later is a purely additive, non-behavioral
 * migration for whichever task next owns `src/database/migrations/**`. */
const FIND_DUE_BATCH_SQL = `
  SELECT r.id, r.reward_entry_id, r.payload, r.attempts, r.next_attempt_at, r.status, r.last_error,
         e.reward_code, e.tracker_code, e.campaign_code, e.tenant_id
    FROM reward_redemption.reward_tracking_dispatch_retry r
    JOIN reward_redemption.reward_redemption_entry e ON e.id = r.reward_entry_id
   WHERE r.status = 'pending' AND r.next_attempt_at <= now()
   ORDER BY r.next_attempt_at ASC
   LIMIT $1
`;

@Injectable()
export class RewardTrackingDispatchRetryRepository implements OnModuleDestroy {
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

  /** TC-5: written once both the primary-channel attempt(s) and the immediate REST fallback
   * attempt have failed for a `reward_tracking_dispatch_outbox` row — `attempts`/`next_attempt_at`/
   * `status` all take the table's own defaults (`0`, `now()`, `'pending'`), so this row is
   * immediately due on the retry worker's very next poll cycle. */
  async create(input: CreateRetryRowInput): Promise<RewardTrackingDispatchRetryRow> {
    const result = await this.pool.query<RewardTrackingDispatchRetryRow>(CREATE_SQL, [
      input.rewardEntryId,
      JSON.stringify(input.payload),
      input.lastError,
    ]);
    const inserted = result.rows[0];
    if (inserted === undefined) {
      throw new Error(
        `reward_tracking_dispatch_retry insert for reward_entry ${input.rewardEntryId} returned ` +
          'no row (structurally unreachable — a plain INSERT with no ON CONFLICT clause).',
      );
    }
    return inserted;
  }

  /** TC-6/TC-7: only rows whose `next_attempt_at` has already elapsed, and only those still
   * `'pending'` (an `'exhausted'` row is never picked up again, no matter how many poll cycles
   * run). */
  async findDueBatch(batchSize: number): Promise<DueRetryRow[]> {
    const result = await this.pool.query<DueRetryRowRaw>(FIND_DUE_BATCH_SQL, [batchSize]);
    return result.rows.map((row) => ({
      id: row.id,
      rewardEntryId: row.reward_entry_id,
      payload: row.payload,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      status: row.status,
      lastError: row.last_error,
      rewardCode: row.reward_code,
      trackerCode: row.tracker_code,
      campaignCode: row.campaign_code,
      tenantId: row.tenant_id,
    }));
  }

  /** TC-8: a due attempt failed again this cycle and the configured `dispatch.retry.maxAttempts`
   * cap has not yet been reached — `attempts` advances by one and `next_attempt_at` is pushed out
   * by the caller-computed exponential-backoff delay. */
  async recordAttemptFailure(id: string, lastError: string, nextAttemptAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE reward_redemption.reward_tracking_dispatch_retry
          SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3, updated_at = now()
        WHERE id = $1`,
      [id, lastError, nextAttemptAt],
    );
  }

  /** TC-8: the configured attempt cap has been reached — terminal, logged, never picked up by
   * `findDueBatch` again, and never retried further automatically (an operator/alerting concern,
   * not this repository's own job, `01-DATABASE.md` §7's own "still visible on the observability
   * dashboard" framing). */
  async markExhausted(id: string, lastError: string): Promise<void> {
    await this.pool.query(
      `UPDATE reward_redemption.reward_tracking_dispatch_retry
          SET status = 'exhausted', last_error = $2, updated_at = now()
        WHERE id = $1`,
      [id, lastError],
    );
  }

  /** TC-7: a later attempt succeeded. `01-DATABASE.md` §7's own DDL comment names only
   * `'pending' | 'exhausted'` for this table's `status` column — no third "delivered"/"resolved"
   * value exists to flip to, so a successfully-delivered row is deleted outright (this file's own
   * header). */
  async markDelivered(id: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM reward_redemption.reward_tracking_dispatch_retry WHERE id = $1',
      [id],
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
