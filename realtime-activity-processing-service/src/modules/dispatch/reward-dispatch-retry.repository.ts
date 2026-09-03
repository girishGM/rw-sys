/**
 * T-RAP-034. `reward_dispatch_retry` — tier 3, the last-resort fallback table (`01-DATABASE.md`
 * §9, `05-PROCESSING-PIPELINE.md` §7 point 3). Not literally named in this task's own "Files
 * owned" list, added here as a small, self-contained repository so `outbox-publisher.service.ts`
 * (which creates a row here when tier 2 also fails) and `reward-dispatch-retry.worker.ts` (which
 * owns everything after that) share one query surface for this one table, rather than duplicating
 * raw SQL across two files — squarely inside this task's own directory file-scope grant
 * (`modules/dispatch/**`), same "a helper file not literally named, added by the task that needs
 * it" precedent `reward-kafka-producer.client.ts`'s own header documents for its sibling.
 *
 * Reuses `PROCESSING_SEQUELIZE` for the same "avoid a redundant second connection pool for a
 * best-effort, non-transactional dispatch concern" reasoning `reward-entry-outbox.repository.ts`'s
 * own header gives.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type { RewardDispatchRetryRow } from '@/database/models/reward-dispatch-retry.model';
import { PROCESSING_SEQUELIZE } from '@/modules/processing/activity-log-claim.repository';

export interface CreateRetryRowInput {
  rewardEntryId: string;
  failureReason: string;
}

@Injectable()
export class RewardDispatchRetryRepository {
  constructor(@Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** TC-5: written once both tier 1 (Kafka) and tier 2 (gRPC) have failed for a given
   * `reward_entry_outbox` row — `status`/`kafka_attempts`/`grpc_attempts`/`next_retry_at` all take
   * the table's own defaults (`'pending'`, `0`, `0`, `now()`), so this row is immediately due. */
  async create(input: CreateRetryRowInput): Promise<RewardDispatchRetryRow> {
    const rows = await this.sequelize.query<RewardDispatchRetryRow>(
      `INSERT INTO realtime_activity_processing.reward_dispatch_retry
         (reward_entry_id, failure_reason)
       VALUES (:rewardEntryId, :failureReason)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: { rewardEntryId: input.rewardEntryId, failureReason: input.failureReason },
      },
    );
    const inserted = rows[0];
    if (inserted === undefined) {
      throw new Error(
        `reward_dispatch_retry insert for reward_entry ${input.rewardEntryId} returned no row.`,
      );
    }
    return inserted;
  }

  /**
   * Implementation note (`01-DATABASE.md` §9's own `ix_reward_dispatch_retry_due` partial index):
   * `WHERE status = 'pending' AND next_retry_at <= now()` matches that index's own column order —
   * a single partial-index scan, not a sequential scan, as this table grows.
   */
  async findDueBatch(batchSize: number): Promise<RewardDispatchRetryRow[]> {
    return this.sequelize.query<RewardDispatchRetryRow>(
      `SELECT * FROM realtime_activity_processing.reward_dispatch_retry
        WHERE status = 'pending' AND next_retry_at <= now()
        ORDER BY next_retry_at ASC
        LIMIT :batchSize`,
      { type: QueryTypes.SELECT, replacements: { batchSize } },
    );
  }

  /** `RewardDispatchRetryWorker` tries Kafka then gRPC, in that order, on every due attempt
   * (implementation note 4: "retries Kafka then gRPC (same order)") — both tiers' own attempt
   * counters advance together on a cycle where neither succeeded, the retry ceiling has not yet
   * been reached, and `next_retry_at` is pushed out by `backoffMs` (exponential backoff, computed
   * by the caller). `failureReason` records the more recent (gRPC) failure — the one that actually
   * decided this cycle stays `pending`. */
  async recordDualAttemptFailure(
    id: string,
    failureReason: string,
    nextRetryAt: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.reward_dispatch_retry
          SET kafka_attempts = kafka_attempts + 1,
              grpc_attempts = grpc_attempts + 1,
              failure_reason = :failureReason,
              next_retry_at = :nextRetryAt,
              updated_at = now()
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id, failureReason, nextRetryAt } },
    );
  }

  /** TC-6: a later attempt succeeded (`05-PROCESSING-PIPELINE.md` §7 point 3's own backoff worker,
   * "Kafka, then gRPC, same order"). */
  async markResolved(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.reward_dispatch_retry
          SET status = 'resolved', updated_at = now()
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id } },
    );
  }

  /** TC-7: the configured attempt cap (`dispatch.config.ts`'s
   * `resolveRewardDispatchMaxRetryAttempts`) has been reached — still queryable/visible
   * (`01-DATABASE.md` §9: "`exhausted` rows are still visible on the observability dashboard"),
   * feeding T-RAP-043. The alerting hook itself is `BACKLOG.md` B-2, out of scope here. */
  async markExhausted(id: string, failureReason: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.reward_dispatch_retry
          SET status = 'exhausted', failure_reason = :failureReason, updated_at = now()
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id, failureReason } },
    );
  }
}
