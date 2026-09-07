/**
 * `reward_redemption.reward_tracking_dispatch_outbox` — outbound leg to
 * reward-tracking-service (`01-DATABASE.md` §7). See `reward-redemption-entry.model.ts`'s header
 * for this directory's own convention. `payload` is typed `Record<string, unknown>` rather than
 * a specific DTO shape — that shape is T-RR-034's own concern (the outbound Kafka publisher),
 * not this migration task's.
 */
export type DispatchOutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

export interface RewardTrackingDispatchOutboxRow {
  id: string;
  reward_entry_id: string;
  topic: string;
  payload: Record<string, unknown>;
  status: DispatchOutboxStatus;
  attempts: number;
  created_at: Date;
  updated_at: Date;
}
