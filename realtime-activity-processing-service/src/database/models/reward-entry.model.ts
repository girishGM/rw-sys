/**
 * `realtime_activity_processing.reward_entry` — one row per earned reward (01-DATABASE.md §7).
 * See `campaign-config-snapshot.model.ts`'s header for this directory's own convention.
 * `dispatch_status`/`dispatch_attempts`/`last_dispatch_error` describe delivery only — R3: this
 * row, once committed, is never rolled back or deleted because a downstream delivery attempt
 * failed.
 *
 * **T-RAP-062**: `reward_kind`/`promo_code_config_id`/`promo_code_config_version_no` (migration
 * `019`) are additive, nullable, descriptive-only metadata mirrored from `BoundReward`
 * (`campaign-config.client.ts`, T-173/T-RAP-065) at grant time — never a new enforcement input
 * (`05-PROCESSING-PIPELINE.md` §6). Optional here (not `string | null` required keys, unlike
 * `merchant_code`) so hand-built `RewardEntryRow` fixtures outside this task's own file scope
 * (e.g. `test/dispatch/**`, owned by no agent's `project.config.json` grant) that predate this
 * task keep compiling unchanged — every real row this service ever queries from Postgres already
 * carries these columns (possibly `null`), never truly absent.
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
  reward_kind?: string | null;
  promo_code_config_id?: string | null;
  promo_code_config_version_no?: number | null;
  dispatch_status: RewardEntryDispatchStatus;
  dispatch_attempts: number;
  last_dispatch_error: string | null;
  created_at: Date;
  updated_at: Date;
}
