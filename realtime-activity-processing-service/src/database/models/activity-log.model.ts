/**
 * `realtime_activity_processing.activity_logs` — the fan-out ledger, the core table
 * (01-DATABASE.md §3). See `campaign-config-snapshot.model.ts`'s header for this directory's own
 * convention.
 *
 * `activity_value` is kept as a `string`, not a `number`, matching `promo-code-service`'s own
 * precedent for `decimal` columns (`promo-code-config.entity.ts`'s header) — Postgres
 * `decimal(18,4)` comes back from `pg` as a string by default, and re-parsing it to a JS `number`
 * risks silent precision loss on a money/quantity value.
 */
export type ActivitySourceTransport = 'KAFKA' | 'GRPC';
export type ActivityLogStatus =
  'pending' | 'processing' | 'processed' | 'error' | 'skipped_duplicate';

export interface ActivityLogRow {
  id: string;
  correlation_id: string;
  dedup_key: string;
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
  source_transport: ActivitySourceTransport;
  activity_reached_date: Date;
  activity_processed_date: Date | null;
  status: ActivityLogStatus;
  error_code: string | null;
  comment: string | null;
  created_at: Date;
  updated_at: Date;
}
