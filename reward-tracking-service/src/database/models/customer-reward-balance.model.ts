import type { RewardKind } from './reward-fact.model';

/**
 * `reward_tracking.customer_reward_balance` — `brain-storm/02-DATA-MODEL.md` §6.1. See
 * `inbound-event-log.model.ts`'s header for this directory's own convention.
 */
export type CustomerRewardBalanceStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED';

export interface CustomerRewardBalanceRow {
  id: string;
  reward_fact_id: string;
  tenant_id: number;
  customer_id_hash: string;
  campaign_code: string;
  reward_category: string;
  unit_type: string | null;
  unit_code: string | null;
  reward_code: string | null;
  reward_kind: RewardKind | null;
  external_reference_id: string | null;
  promo_code_config_id: string | null;
  promo_code_config_version_no: number | null;
  issued_value: string;
  status: CustomerRewardBalanceStatus;
  issued_at: Date;
  expires_at: Date | null;
  used_at: Date | null;
  updated_at: Date;
}
