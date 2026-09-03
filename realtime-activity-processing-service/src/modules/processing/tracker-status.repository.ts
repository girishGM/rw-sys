/**
 * T-RAP-032. `customer_tracker_status` — the tracker-level completion aggregate (`01-DATABASE.md`
 * §5). Every write here happens inside the **same** transaction/advisory-lock scope
 * `rule-evaluation-row-handler.service.ts` opened for T-RAP-031's own component-level write — this
 * task's own Scope note: "still inside the same transaction/advisory-lock scope T-RAP-031 opened
 * ... not a separate claim/lock cycle" (R2: the advisory lock already held serializes every write a
 * single customer+campaign could produce; the `SELECT ... FOR UPDATE` below and `uc_cts`'s unique
 * index are R2's other two layers, same "all three, every time" discipline
 * `tracker-component-progress.repository.ts` already established).
 *
 * Reuses `PROCESSING_SEQUELIZE` rather than opening a second connection — same module, same
 * task-chain.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type { CustomerTrackerStatusRow } from '@/database/models/customer-tracker-status.model';
import { PROCESSING_SEQUELIZE } from './activity-log-claim.repository';
import { TrackerCompletionEvaluatorService } from './tracker-completion-evaluator.service';

export interface UpsertTrackerStatusInput {
  tenantId: number;
  customerIdHash: string;
  campaignCode: string;
  trackerCode: string;
  completionLogic: string;
  completionThreshold: number;
  /** Total component membership under this tracker at the moment of this write (the cached
   * `tracker.components.length`) — refreshed onto the row on every write, same convention
   * `tracker-component-progress.repository.ts`'s own `requiredCount` follows, except an
   * already-completed row for the current `completion_cycle`, which is never touched again. */
  componentsRequiredCount: number;
}

export interface UpsertTrackerStatusResult {
  row: CustomerTrackerStatusRow;
  /** `true` only when *this* write is what flipped the tracker's own `is_completed` from `false`
   * to `true` (or created a brand-new, already-satisfied row) — never `true` again for a tracker
   * already complete before this write. This is the "tracker-level completion" signal
   * `05-PROCESSING-PIPELINE.md` §6 needs for tracker/campaign-level reward assignments — T-RAP-033's
   * own extension point, not consumed by this task. */
  justCompleted: boolean;
}

@Injectable()
export class TrackerStatusRepository {
  constructor(
    @Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly completionEvaluator: TrackerCompletionEvaluatorService,
  ) {}

  /**
   * Called only when the caller's own component-level write (T-RAP-031) just flipped a component's
   * `is_completed` (`05-PROCESSING-PIPELINE.md` §5 point 2's own "once per completion, not once per
   * activity" framing) — this repository has no opinion of its own on when it should be called.
   * Locates the latest `completion_cycle` row for this (tenant, customer, campaign, tracker) tuple
   * with `SELECT ... FOR UPDATE`, then:
   *  - no row yet → insert `completion_cycle = 1`, `components_completed_count = 1` (TC-1..4).
   *  - row exists, not yet completed → increment `components_completed_count` in place.
   *  - row exists, already completed (a repeatable tracker starting a new cycle) → insert a *new*
   *    row at `completion_cycle + 1` rather than continuing to add to the completed one (TC-5) —
   *    `uc_cts`'s own unique index is the structural backstop against a concurrent double-insert of
   *    the same cycle (R2's third layer).
   */
  async upsertOnComponentCompletion(
    transaction: Transaction,
    input: UpsertTrackerStatusInput,
  ): Promise<UpsertTrackerStatusResult> {
    const existingRows = await this.sequelize.query<CustomerTrackerStatusRow>(
      `SELECT * FROM realtime_activity_processing.customer_tracker_status
        WHERE tenant_id = :tenantId
          AND customer_id_hash = :customerIdHash
          AND campaign_code = :campaignCode
          AND tracker_code = :trackerCode
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
    input: UpsertTrackerStatusInput,
    completionCycle: number,
  ): Promise<UpsertTrackerStatusResult> {
    const justCompleted = this.completionEvaluator.isComplete({
      completionLogic: input.completionLogic,
      completionThreshold: input.completionThreshold,
      componentsRequiredCount: input.componentsRequiredCount,
      componentsCompletedCount: 1,
    });
    const rows = await this.sequelize.query<CustomerTrackerStatusRow>(
      `INSERT INTO realtime_activity_processing.customer_tracker_status
         (tenant_id, customer_id_hash, campaign_code, tracker_code, completion_cycle,
          components_required_count, components_completed_count, is_completed, completed_at)
       VALUES
         (:tenantId, :customerIdHash, :campaignCode, :trackerCode, :completionCycle,
          :componentsRequiredCount, 1, :isCompleted, :completedAt)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          tenantId: input.tenantId,
          customerIdHash: input.customerIdHash,
          campaignCode: input.campaignCode,
          trackerCode: input.trackerCode,
          completionCycle,
          componentsRequiredCount: input.componentsRequiredCount,
          isCompleted: justCompleted,
          completedAt: justCompleted ? new Date() : null,
        },
      },
    );
    return { row: rows[0], justCompleted };
  }

  private async incrementExisting(
    transaction: Transaction,
    existing: CustomerTrackerStatusRow,
    input: UpsertTrackerStatusInput,
  ): Promise<UpsertTrackerStatusResult> {
    const newCount = existing.components_completed_count + 1;
    const justCompleted = this.completionEvaluator.isComplete({
      completionLogic: input.completionLogic,
      completionThreshold: input.completionThreshold,
      componentsRequiredCount: input.componentsRequiredCount,
      componentsCompletedCount: newCount,
    });
    const rows = await this.sequelize.query<CustomerTrackerStatusRow>(
      `UPDATE realtime_activity_processing.customer_tracker_status
          SET components_completed_count = :newCount,
              components_required_count = :componentsRequiredCount,
              is_completed = :isCompleted,
              completed_at = CASE WHEN :isCompleted THEN now() ELSE completed_at END,
              updated_at = now()
        WHERE id = :id
        RETURNING *`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          newCount,
          componentsRequiredCount: input.componentsRequiredCount,
          isCompleted: justCompleted,
          id: existing.id,
        },
      },
    );
    return { row: rows[0], justCompleted };
  }
}
