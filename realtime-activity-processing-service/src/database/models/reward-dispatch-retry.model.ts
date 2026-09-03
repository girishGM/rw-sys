/**
 * `realtime_activity_processing.reward_dispatch_retry` — last-resort dispatch fallback table
 * (01-DATABASE.md §9). See `campaign-config-snapshot.model.ts`'s header for this directory's own
 * convention.
 */
export type RewardDispatchRetryStatus = 'pending' | 'exhausted' | 'resolved';

export interface RewardDispatchRetryRow {
  id: string;
  reward_entry_id: string;
  kafka_attempts: number;
  grpc_attempts: number;
  failure_reason: string;
  status: RewardDispatchRetryStatus;
  next_retry_at: Date;
  created_at: Date;
  updated_at: Date;
}
