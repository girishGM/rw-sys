/**
 * T-RAP-033. `customer_reward_limit_consumption` — per-customer reward-limit consumption
 * (`01-DATABASE.md` §6, `cap_class = 'limit'`). Same reserve-then-commit discipline as
 * `budget-consumption.repository.ts` (007/008 migrations share the same shape), keyed additionally
 * by `customer_id_hash`/`assignment_level` (never plaintext `customerId` — R4).
 *
 * Unlike the pooled `budget_consumption` row, a limit row is only ever contended by the *same*
 * customer — already serialized by the per-customer advisory lock
 * (`05-PROCESSING-PIPELINE.md` §3) — but the `SELECT ... FOR UPDATE`/unique-index pair is still
 * taken every time regardless (R2: "all three layers, every time", never skipped because "this
 * path can't really race").
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type {
  CustomerRewardLimitConsumptionRow,
  RewardLimitAssignmentLevel,
} from '@/database/models/customer-reward-limit-consumption.model';
import { PROCESSING_SEQUELIZE } from '@/modules/processing/activity-log-claim.repository';

export interface CustomerLimitConsumptionKey {
  tenantId: number;
  customerIdHash: string;
  campaignCode: string;
  /** See `budget-consumption.repository.ts`'s own `BudgetConsumptionKey.rewardPolicyCode` header
   * — same derived "which cap" identity, same reason. */
  rewardPolicyCode: string;
  assignmentLevel: RewardLimitAssignmentLevel;
  periodStart: Date;
  periodEnd: Date;
}

@Injectable()
export class CustomerLimitConsumptionRepository {
  constructor(@Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** See `BudgetConsumptionRepository.lockOrCreate`'s own header — identical
   * `INSERT ... ON CONFLICT DO NOTHING` then `SELECT ... FOR UPDATE` pattern, applied to
   * `customer_reward_limit_consumption`'s own unique index (`uc_customer_reward_limit`). */
  async lockOrCreate(
    transaction: Transaction,
    key: CustomerLimitConsumptionKey,
  ): Promise<CustomerRewardLimitConsumptionRow> {
    await this.sequelize.query(
      `INSERT INTO realtime_activity_processing.customer_reward_limit_consumption
         (tenant_id, customer_id_hash, campaign_code, reward_policy_code, assignment_level,
          period_start, period_end)
       VALUES
         (:tenantId, :customerIdHash, :campaignCode, :rewardPolicyCode, :assignmentLevel,
          :periodStart, :periodEnd)
       ON CONFLICT (tenant_id, customer_id_hash, campaign_code, reward_policy_code,
                     assignment_level, period_start) DO NOTHING`,
      {
        type: QueryTypes.RAW,
        transaction,
        replacements: {
          tenantId: key.tenantId,
          customerIdHash: key.customerIdHash,
          campaignCode: key.campaignCode,
          rewardPolicyCode: key.rewardPolicyCode,
          assignmentLevel: key.assignmentLevel,
          periodStart: key.periodStart,
          periodEnd: key.periodEnd,
        },
      },
    );
    const rows = await this.sequelize.query<CustomerRewardLimitConsumptionRow>(
      `SELECT * FROM realtime_activity_processing.customer_reward_limit_consumption
        WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash
          AND campaign_code = :campaignCode AND reward_policy_code = :rewardPolicyCode
          AND assignment_level = :assignmentLevel AND period_start = :periodStart
        FOR UPDATE`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          tenantId: key.tenantId,
          customerIdHash: key.customerIdHash,
          campaignCode: key.campaignCode,
          rewardPolicyCode: key.rewardPolicyCode,
          assignmentLevel: key.assignmentLevel,
          periodStart: key.periodStart,
        },
      },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(
        `customer_reward_limit_consumption row missing immediately after lockOrCreate for ` +
          `tenant=${key.tenantId} campaign=${key.campaignCode} cap=${key.rewardPolicyCode}/` +
          `${key.assignmentLevel} period_start=${key.periodStart.toISOString()}`,
      );
    }
    return row;
  }

  /** See `BudgetConsumptionRepository.increment`'s own header — same "no check of its own"
   * contract. */
  async increment(
    transaction: Transaction,
    id: string,
    deltaAmount: string,
    deltaCount: number,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.customer_reward_limit_consumption
          SET consumed_amount = consumed_amount + :deltaAmount,
              consumed_count = consumed_count + :deltaCount,
              updated_at = now()
        WHERE id = :id`,
      { type: QueryTypes.RAW, transaction, replacements: { id, deltaAmount, deltaCount } },
    );
  }
}
