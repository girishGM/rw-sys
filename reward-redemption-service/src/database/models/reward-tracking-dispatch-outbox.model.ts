/**
 * `reward_redemption.reward_tracking_dispatch_outbox` — outbound leg to
 * reward-tracking-service (`01-DATABASE.md` §7). See `reward-redemption-entry.model.ts`'s header
 * for this directory's own convention. `payload` is typed `Record<string, unknown>` rather than
 * a specific DTO shape — that shape is T-RR-034's own concern (the outbound Kafka publisher),
 * not this migration task's.
 *
 * **T-INT-051** adds the `'POISONED'` terminal status — a row that threw before any dispatch
 * attempt even started (e.g. `EncryptionService.decrypt` on a permanently-undecryptable
 * `customerIdEncrypted`) some configured number of consecutive times in a row, so
 * `outbox-publisher.service.ts`'s own strict-FIFO `findPendingBatch` batch query stops returning
 * it forever, freeing every genuinely-dispatchable row queued behind it. No schema change was
 * needed to add the *value* itself (`status` is an unconstrained `varchar(20)`,
 * `010_create_reward_tracking_dispatch_outbox.ts`'s own header) — only the new, nullable
 * `last_error` column (migration `026`), for `findPoisoned()`'s own operator-audit use.
 */
export type DispatchOutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED' | 'POISONED';

export interface RewardTrackingDispatchOutboxRow {
  id: string;
  reward_entry_id: string;
  topic: string;
  payload: Record<string, unknown>;
  status: DispatchOutboxStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}
