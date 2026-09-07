/**
 * `reward_redemption.reward_tracking_dispatch_retry` — tier-3 retry queue for the outbound leg
 * to reward-tracking-service (`01-DATABASE.md` §7). See `reward-redemption-entry.model.ts`'s
 * header for this directory's own convention.
 */
export type DispatchRetryStatus = 'pending' | 'exhausted';

export interface RewardTrackingDispatchRetryRow {
  id: string;
  reward_entry_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  next_attempt_at: Date;
  status: DispatchRetryStatus;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}
