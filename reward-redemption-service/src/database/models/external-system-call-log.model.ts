/**
 * `reward_redemption.external_system_call_log` — observability audit of every connector call
 * (`01-DATABASE.md` §9). See `reward-redemption-entry.model.ts`'s header for this directory's
 * own convention. `request_summary`/`response_summary` must never carry PII or credentials
 * (R8/R9) — enforced by each connector's own construction of the summary, not by this shape.
 */
export type ExternalSystemCallResult = 'SUCCESS' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE';

export interface ExternalSystemCallLogRow {
  id: string;
  reward_entry_id: string;
  system_code: string;
  attempt_number: number;
  request_summary: Record<string, unknown>;
  response_summary: Record<string, unknown> | null;
  result: ExternalSystemCallResult;
  error_code: string | null;
  latency_ms: number;
  called_at: Date;
}
