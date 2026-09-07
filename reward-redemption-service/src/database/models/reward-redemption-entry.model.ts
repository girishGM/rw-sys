/**
 * `reward_redemption.reward_redemption_entry` — the inbound ledger and idempotency anchor
 * (`01-DATABASE.md` §1). Following RAP's/promo-code-service's own convention (confirmed by direct
 * read of `realtime-activity-processing-service/src/database/models/*.model.ts`): migrations are
 * raw SQL, not `sequelize-typescript` `@Table` classes, and these `models/*.ts` files are the
 * shared, schema-level source of truth for a table's raw row shape (snake_case, exactly as
 * Postgres/`pg` returns it) — the one place every later task's own repository/service imports
 * from, instead of each re-declaring the same columns. Domain (camelCase) DTO mapping is each
 * consuming module's own concern (Wave 1's `RewardIngestionService` and friends), not this task's.
 *
 * `status` is a string union matching `05-PROCESSING-PIPELINE.md` §2's six values, not a bare
 * `string` (T-RR-002 note 6 / R2) — a later task assigning an invalid status value is a compile
 * error, not a runtime surprise. `activity_value`/`reward_value` are typed `string`, matching how
 * `pg`/Sequelize actually returns a `decimal` column (a JS `number` would silently lose precision
 * on the round trip) — same convention as RAP's own `reward-entry.model.ts`.
 */
export type RewardRedemptionEntryStatus =
  'received' | 'processing' | 'dispatched_external' | 'completed' | 'retrying' | 'failed';

export type IngestionChannel = 'GRPC' | 'KAFKA' | 'REST';

export interface RewardRedemptionEntryRow {
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
  reward_processed_env: string;
  country_code: string | null;
  tenant_code: string | null;
  ingestion_channel: IngestionChannel;
  status: RewardRedemptionEntryStatus;
  retry_count: number;
  next_attempt_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_attempted_at: Date | null;
  external_system_code: string | null;
  external_reference_id: string | null;
  redeemed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
