/**
 * T-RAP-033. `budget_consumption` — campaign-scope (pooled) budget cap consumption
 * (`01-DATABASE.md` §6). Every write here happens inside the same transaction/advisory-lock scope
 * `rule-evaluation-row-handler.service.ts` opens (R2's row-lock layer — `05-PROCESSING-PIPELINE.md`
 * §3: "a campaign-level budget is shared across all customers — the per-customer advisory lock ...
 * does not by itself serialize two different customers both spending against the same campaign
 * budget at once; the row lock does").
 *
 * Reuses `PROCESSING_SEQUELIZE` (`activity-log-claim.repository.ts`) rather than opening a second
 * connection — same convention `tracker-component-progress.repository.ts` (T-RAP-031) already
 * established for this same file-scope owner's task chain.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type { BudgetConsumptionRow } from '@/database/models/budget-consumption.model';
import { PROCESSING_SEQUELIZE } from '@/modules/processing/activity-log-claim.repository';

export interface BudgetConsumptionKey {
  tenantId: number;
  campaignCode: string;
  /** This service's own derived "which cap" identity, not a literal reward-policy code — see
   * `cap-enforcement.service.ts`'s `deriveCapKey` header for why (`CampaignCap`, the real cached
   * shape, carries no numeric id to key this column with; `reward_policy_code`/`cap_type` predate
   * that confirmed shape, `01-DATABASE.md` §6). */
  rewardPolicyCode: string;
  capType: string;
  periodStart: Date;
  periodEnd: Date;
}

@Injectable()
export class BudgetConsumptionRepository {
  constructor(@Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * `05-PROCESSING-PIPELINE.md` §6 point 2 / §3: `SELECT ... FOR UPDATE` the campaign-scoped
   * budget row for one cap + period bucket — the row-lock layer that serializes two *different*
   * customers spending against the same pooled budget (R2; the per-customer advisory lock alone
   * does not, since it is keyed per customer, not per campaign budget).
   *
   * Creates the row (idempotently) if this is the first reservation attempt in this bucket:
   * `INSERT ... ON CONFLICT DO NOTHING` followed by `SELECT ... FOR UPDATE` is what stays
   * race-free under concurrent first-touch — the `ON CONFLICT` arm no-ops if a concurrent
   * transaction's own insert already won, and the following `SELECT ... FOR UPDATE` then simply
   * blocks on *that* transaction's row lock until it commits or rolls back — exactly the
   * serialization TC-5 exists to prove (never both transactions reading a stale "no row yet"
   * and racing an unguarded increment).
   */
  async lockOrCreate(
    transaction: Transaction,
    key: BudgetConsumptionKey,
  ): Promise<BudgetConsumptionRow> {
    await this.sequelize.query(
      `INSERT INTO realtime_activity_processing.budget_consumption
         (tenant_id, campaign_code, reward_policy_code, cap_type, period_start, period_end)
       VALUES (:tenantId, :campaignCode, :rewardPolicyCode, :capType, :periodStart, :periodEnd)
       ON CONFLICT (tenant_id, campaign_code, reward_policy_code, cap_type, period_start) DO NOTHING`,
      {
        type: QueryTypes.RAW,
        transaction,
        replacements: {
          tenantId: key.tenantId,
          campaignCode: key.campaignCode,
          rewardPolicyCode: key.rewardPolicyCode,
          capType: key.capType,
          periodStart: key.periodStart,
          periodEnd: key.periodEnd,
        },
      },
    );
    const rows = await this.sequelize.query<BudgetConsumptionRow>(
      `SELECT * FROM realtime_activity_processing.budget_consumption
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode
          AND reward_policy_code = :rewardPolicyCode AND cap_type = :capType
          AND period_start = :periodStart
        FOR UPDATE`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          tenantId: key.tenantId,
          campaignCode: key.campaignCode,
          rewardPolicyCode: key.rewardPolicyCode,
          capType: key.capType,
          periodStart: key.periodStart,
        },
      },
    );
    const row = rows[0];
    if (row === undefined) {
      // Structurally unreachable (the INSERT above guarantees the row exists before this SELECT
      // runs) — a named, loud failure rather than returning `undefined` silently if it ever is.
      throw new Error(
        `budget_consumption row missing immediately after lockOrCreate for tenant=${key.tenantId} ` +
          `campaign=${key.campaignCode} cap=${key.rewardPolicyCode}/${key.capType} ` +
          `period_start=${key.periodStart.toISOString()}`,
      );
    }
    return row;
  }

  /** Increments an already-locked row (`lockOrCreate`'s own row, same transaction, same
   * connection) — called only after the caller has confirmed the increment stays within the cap's
   * ceiling; this method performs no check of its own (`01-DATABASE.md` §6: "reserve-then-commit,
   * never check-then-insert-separately"). */
  async increment(
    transaction: Transaction,
    id: string,
    deltaAmount: string,
    deltaCount: number,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.budget_consumption
          SET consumed_amount = consumed_amount + :deltaAmount,
              consumed_count = consumed_count + :deltaCount,
              updated_at = now()
        WHERE id = :id`,
      { type: QueryTypes.RAW, transaction, replacements: { id, deltaAmount, deltaCount } },
    );
  }
}
