/**
 * `realtime_activity_processing.reward_entry_outbox` — transactional outbox, Kafka leg
 * (01-DATABASE.md §8). See `campaign-config-snapshot.model.ts`'s header for this directory's own
 * convention.
 */
export type RewardEntryOutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

export interface RewardEntryOutboxRow {
  id: string;
  reward_entry_id: string;
  topic: string;
  payload: unknown;
  status: RewardEntryOutboxStatus;
  attempts: number;
  created_at: Date;
  published_at: Date | null;
}
