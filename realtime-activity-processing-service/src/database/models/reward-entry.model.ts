/**
 * `realtime_activity_processing.reward_entry` — one row per earned reward (01-DATABASE.md §7).
 * See `campaign-config-snapshot.model.ts`'s header for this directory's own convention.
 * `dispatch_status`/`dispatch_attempts`/`last_dispatch_error` describe delivery only — R3: this
 * row, once committed, is never rolled back or deleted because a downstream delivery attempt
 * failed.
 */
export type RewardEntryDispatchStatus = 'pending' | 'dispatched' | 'failed';

export interface RewardEntryRow {
  id: string;
  correlation_id: string;
  tenant_id: number;
  customer_id_encrypted: string;
  customer_id_hash: string;
  customer_id_type: string;
  activity_performed_date: Date;
  transaction_type: string | null;
  activity_code: string | null;
  activity_type: string;
  activity_category: string;
  activity_value: string;
  activity_value_unit: string;
  channel: string;
  activity_performed_env: string;
  activity_name: string;
  campaign_code: string;
  tracker_code: string;
  tracker_component_code: string;
  merchant_code: string | null;
  reward_code: string;
  reward_category: string;
  reward_value: string;
  reward_value_unit: string;
  reward_entry_date: Date;
  completion_cycle: number;
  dispatch_status: RewardEntryDispatchStatus;
  dispatch_attempts: number;
  last_dispatch_error: string | null;
  created_at: Date;
  updated_at: Date;
}
