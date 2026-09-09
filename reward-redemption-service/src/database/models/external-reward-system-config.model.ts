/**
 * `reward_redemption.external_reward_system_config` — connector config + retryable-error-code
 * cache source (`01-DATABASE.md` §3). See `reward-redemption-entry.model.ts`'s header for this
 * directory's own convention (plain row interfaces, snake_case, matching what `pg`/Sequelize
 * actually returns — not `@Table` classes).
 *
 * `retryable_error_codes` is typed `string[]`, matching the jsonb column's own documented shape
 * (`e.g. ["GENERATION_EXHAUSTED"]`) — `pg`'s own jsonb parsing already returns a parsed JS value
 * for a `jsonb` column, never a raw string that needs a second `JSON.parse`.
 */
// Open-ended by design (`01-DATABASE.md` §3: "'PROMO_CODE_SERVICE' | 'CORE_BANKING' | ..." — new
// connector types are added by later waves, e.g. T-RR-031/T-RR-032, without a migration here) —
// left as `string` rather than a closed union that would need editing every time a new connector
// type ships.
export type ExternalRewardSystemConfigStatus = 'active' | 'inactive';

export interface ExternalRewardSystemConfigRow {
  id: number;
  system_code: string;
  tenant_id: number | null;
  connector_type: string;
  endpoint_url: string;
  auth_secret_ref: string;
  retryable_error_codes: string[];
  max_retry_attempts: number;
  retry_backoff_base_ms: number;
  retry_backoff_max_ms: number;
  status: ExternalRewardSystemConfigStatus;
  created_at: Date;
  updated_at: Date;
  tenant_key: number;
}
