/**
 * `reward_tracking.reward_fact` — `brain-storm/02-DATA-MODEL.md` §2.1. See
 * `inbound-event-log.model.ts`'s header for this directory's own convention.
 *
 * `reward_kind` is `null` until `T-173`/`T-RAP-062`/`T-RR-062` (upstream) land — every consumer of
 * this row must treat a `null` `reward_kind` as non-summable, never as "assume FIXED_AMOUNT" (§2.2).
 */
export type RewardKind = 'FIXED_AMOUNT' | 'PERCENTAGE' | 'POINTS' | 'PHYSICAL' | 'PROMO_CODE';
export type RewardLifecycleStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED';

export interface RewardFactRow {
  id: string;
  reward_entry_id: string;
  correlation_id: string;
  tenant_id: number;
  tenant_code: string | null;
  country_code: string | null;
  customer_id_encrypted: string;
  customer_id_hash: string;
  campaign_code: string;
  tracker_code: string | null;
  tracker_component_code: string | null;
  merchant_code: string | null;
  reward_code: string;
  reward_category: string;
  reward_kind: RewardKind | null;
  unit_type: string | null;
  unit_code: string | null;
  reward_value: string;
  reward_value_unit: string;
  external_system_code: string | null;
  external_reference_id: string | null;
  promo_code_config_id: string | null;
  promo_code_config_version_no: number | null;
  redeemed_at: Date;
  expires_at: Date | null;
  reward_lifecycle_status: RewardLifecycleStatus;
  ingested_at: Date;
  created_at: Date;
}
