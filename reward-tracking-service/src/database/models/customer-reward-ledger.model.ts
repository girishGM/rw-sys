import type { RewardKind } from './reward-fact.model';

/**
 * `reward_tracking.customer_reward_ledger` — `brain-storm/02-DATA-MODEL.md` §3.1. See
 * `inbound-event-log.model.ts`'s header for this directory's own convention.
 */
export interface CustomerRewardLedgerRow {
  id: string;
  tenant_id: number;
  customer_id_hash: string;
  campaign_code: string;
  tracker_code: string;
  tracker_component_code: string;
  reward_category: string;
  reward_kind: RewardKind | null;
  unit_type: string | null;
  unit_code: string | null;
  total_reward_value: string;
  total_reward_count: number;
  first_earned_at: Date;
  last_earned_at: Date;
  updated_at: Date;
}
