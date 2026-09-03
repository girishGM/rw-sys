/**
 * T-RAP-031. `customer_tracker_component_progress` — the fast-read progress table
 * (`01-DATABASE.md` §4). Every write here happens inside the same transaction/advisory-lock scope
 * `rule-evaluation-row-handler.service.ts` opens (R2: advisory lock first, `SELECT ... FOR UPDATE`
 * on the row this task's own write touches, the `uc_ctcp` unique index as the final backstop —
 * "all three, every time", even though the advisory lock alone already serializes every write a
 * single customer+campaign could produce).
 *
 * Reuses `PROCESSING_SEQUELIZE` (`activity-log-claim.repository.ts`) rather than opening a second
 * connection — same module, same task-chain (T-RAP-030's own connection, extended by this task and
 * every later task in this same file-scope owner's queue).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type { CustomerTrackerComponentProgressRow } from '@/database/models/customer-tracker-component-progress.model';
import { PROCESSING_SEQUELIZE } from './activity-log-claim.repository';

export interface UpsertProgressInput {
  tenantId: number;
  customerIdHash: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  /** Current cached required count (`RuleEvaluatorService.resolveRequiredCount`) — refreshed onto
   * the row on every write (task implementation note 3: "if the cache changes ... between two
   * contributing activities, the new value is what a fresh row picks up"), except an already-
   * completed row, which is never touched again for its own `completion_cycle` (implementation
   * note 3's other half: "an already-`is_completed = true` row is never un-completed"). */
  requiredCount: number;
  activityLogId: string;
}

export interface UpsertProgressResult {
  row: CustomerTrackerComponentProgressRow;
  /** `true` only when *this* write is what flipped `is_completed` from `false` to `true` (or
   * created a brand-new, already-satisfied row: `requiredCount <= 1`) — never `true` again for a
   * row that was already complete before this write (`05-PROCESSING-PIPELINE.md` §6's own "once
   * per completion, not once per activity" framing, which T-RAP-032/033 rely on this flag for). */
  justCompleted: boolean;
}

@Injectable()
export class TrackerComponentProgressRepository {
  constructor(@Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Called only when the claimed row's bound rules all passed (the caller's own concern — this
   * repository has no rule-evaluation logic of its own). Locates the latest `completion_cycle` row
   * for this (tenant, customer, campaign, tracker, component) tuple with `SELECT ... FOR UPDATE`,
   * then:
   *  - no row yet → insert `completion_cycle = 1` (TC-1/TC-2).
   *  - row exists, not yet completed → increment `current_count` in place (TC-4's own "no lost
   *    update" property, guaranteed jointly by the advisory lock already held and this row lock).
   *  - row exists, already completed (a repeatable component starting a new cycle) → insert a
   *    *new* row at `completion_cycle + 1` rather than continuing to add to the completed one
   *    (TC-5) — `uc_ctcp`'s own unique index is what makes a concurrent double-insert of the same
   *    cycle structurally impossible even if the locks above were somehow bypassed (R2's third
   *    layer).
   */
  async upsertOnPassingActivity(
    transaction: Transaction,
    input: UpsertProgressInput,
  ): Promise<UpsertProgressResult> {
    const existingRows = await this.sequelize.query<CustomerTrackerComponentProgressRow>(
      `SELECT * FROM realtime_activity_processing.customer_tracker_component_progress
        WHERE tenant_id = :tenantId
          AND customer_id_hash = :customerIdHash
          AND campaign_code = :campaignCode
          AND tracker_code = :trackerCode
          AND tracker_component_code = :trackerComponentCode
        ORDER BY completion_cycle DESC
        LIMIT 1
        FOR UPDATE`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          tenantId: input.tenantId,
          customerIdHash: input.customerIdHash,
          campaignCode: input.campaignCode,
          trackerCode: input.trackerCode,
          trackerComponentCode: input.trackerComponentCode,
        },
      },
    );
    const existing = existingRows[0] ?? null;

    if (existing === null) {
      return this.insertNewCycle(transaction, input, 1);
    }
    if (existing.is_completed) {
      return this.insertNewCycle(transaction, input, existing.completion_cycle + 1);
    }
    return this.incrementExisting(transaction, existing, input);
  }

  private async insertNewCycle(
    transaction: Transaction,
    input: UpsertProgressInput,
    completionCycle: number,
  ): Promise<UpsertProgressResult> {
    const justCompleted = 1 >= input.requiredCount;
    const rows = await this.sequelize.query<CustomerTrackerComponentProgressRow>(
      `INSERT INTO realtime_activity_processing.customer_tracker_component_progress
         (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
          current_count, required_count, completion_cycle, is_completed, completed_at,
          last_activity_log_id)
       VALUES
         (:tenantId, :customerIdHash, :campaignCode, :trackerCode, :trackerComponentCode,
          1, :requiredCount, :completionCycle, :isCompleted, :completedAt, :activityLogId)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          tenantId: input.tenantId,
          customerIdHash: input.customerIdHash,
          campaignCode: input.campaignCode,
          trackerCode: input.trackerCode,
          trackerComponentCode: input.trackerComponentCode,
          requiredCount: input.requiredCount,
          completionCycle,
          isCompleted: justCompleted,
          completedAt: justCompleted ? new Date() : null,
          activityLogId: input.activityLogId,
        },
      },
    );
    return { row: rows[0], justCompleted };
  }

  private async incrementExisting(
    transaction: Transaction,
    existing: CustomerTrackerComponentProgressRow,
    input: UpsertProgressInput,
  ): Promise<UpsertProgressResult> {
    const newCount = existing.current_count + 1;
    const justCompleted = newCount >= input.requiredCount;
    const rows = await this.sequelize.query<CustomerTrackerComponentProgressRow>(
      `UPDATE realtime_activity_processing.customer_tracker_component_progress
          SET current_count = :newCount,
              required_count = :requiredCount,
              is_completed = :isCompleted,
              completed_at = CASE WHEN :isCompleted THEN now() ELSE completed_at END,
              last_activity_log_id = :activityLogId,
              updated_at = now()
        WHERE id = :id
        RETURNING *`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          newCount,
          requiredCount: input.requiredCount,
          isCompleted: justCompleted,
          activityLogId: input.activityLogId,
          id: existing.id,
        },
      },
    );
    return { row: rows[0], justCompleted };
  }
}
