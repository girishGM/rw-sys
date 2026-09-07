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
  /** T-RR-063 (migration `020`). The absolute UTC instant this redeemed reward stops being
   * usable, computed at redemption time from the resolved `BoundReward`'s `expiry_value`/
   * `expiry_unit` duration (T-173) — `null` when the reward never expires, or when the row has
   * not yet reached `dispatched_external`/`completed` (the only two writers of this column,
   * `redemption-state-machine.service.ts`).
   *
   * **Deliberately optional (`?`), unlike every sibling nullable column above** (e.g.
   * `next_attempt_at: Date | null`, always required): this field was appended after several other
   * tasks' own fixture builders across the tree already constructed full `RewardRedemptionEntryRow`
   * object literals (e.g. `test/security/connector-credential-leakage.spec.ts`, outside this task's
   * file scope, R3) — making it required would force an edit to every one of those files just to
   * keep them compiling, for a column their own tests have no opinion on. `pg`/Sequelize still
   * always returns the real column (a real `null` for any pre-existing or never-expiring row), so
   * every actual runtime read remains exactly `Date | null`; `?` only widens what a hand-built test
   * literal is allowed to omit.
   */
  expires_at?: Date | null;
  /** T-RR-062 (migration `022`, implementation notes 1a/1b). Distinguishes a `PERCENTAGE` reward's
   * `reward_value` (a rate, never meaningfully summable) from a `FIXED_AMOUNT`/`POINTS` reward's (a
   * real, additive amount) and from a `PROMO_CODE` reward (tracked as the code itself, never a
   * redemption value) — the `reward-tracking-service` aggregation-design gap this task's own header
   * describes. `null` until `realtime-activity-processing-service-plan/tasks/T-RAP-062` (still
   * `pending`) starts stamping it upstream **and** this service's own Wave 1 ingestion is separately
   * extended to read it — never fabricated in the meantime. Optional (`?`), same reasoning as
   * `expires_at` immediately above: several fixture builders across the tree
   * (e.g. `test/security/connector-credential-leakage.spec.ts`, outside this task's file scope, R3)
   * already construct full `RewardRedemptionEntryRow` object literals that predate this field. */
  reward_kind?: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'POINTS' | 'PROMO_CODE' | null;
  /** T-RR-062 (migration `022`, implementation note 1b). Which promo-code recipe produced this
   * `reward_kind = 'PROMO_CODE'` entry — `null` for every other `reward_kind`, and `null` for every
   * row until the same cross-repo blocker as `reward_kind` above lands. This task only persists and
   * forwards whatever value RAP already stamped; it never calls promo-code-service itself and never
   * resolves a version on its own (that is `T-RR-082`'s own, distinct scope). Optional (`?`), same
   * reasoning as `reward_kind`/`expires_at` above. */
  promo_code_config_id?: string | null;
  /** T-RR-062 (migration `022`, implementation note 1b). Sibling to `promo_code_config_id` — which
   * version of that config produced this entry. Optional (`?`), same reasoning as its siblings
   * above. */
  promo_code_config_version_no?: number | null;
  created_at: Date;
  updated_at: Date;
}
