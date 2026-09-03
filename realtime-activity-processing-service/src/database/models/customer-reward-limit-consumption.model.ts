/**
 * `realtime_activity_processing.customer_reward_limit_consumption` — per-customer reward-limit
 * consumption (01-DATABASE.md §6). See `campaign-config-snapshot.model.ts`'s header for this
 * directory's own convention.
 */
export type RewardLimitAssignmentLevel = 'component' | 'tracker' | 'campaign';

export interface CustomerRewardLimitConsumptionRow {
  id: string;
  tenant_id: number;
  customer_id_hash: string;
  campaign_code: string;
  reward_policy_code: string;
  assignment_level: RewardLimitAssignmentLevel;
  period_start: Date;
  period_end: Date;
  consumed_amount: string;
  consumed_count: number;
  updated_at: Date;
}
