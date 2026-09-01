/**
 * T-006 — payload shapes of the two named SSE events `tracking-service` emits (`routes/
 * events.ts`'s `SseHub.emit` call sites in `routes/activities.ts`), consumed by
 * `lib/sseClient.ts`.
 */
import type { RewardLedgerEntry } from './reward';

/** `event: progress-updated` — one tracker component's completion state changed. */
export interface ProgressUpdatedPayload {
  readonly campaignId: number;
  readonly trackerId: number;
  readonly componentId: number;
  readonly completedCount: number;
  readonly threshold: number;
  readonly trackerCompleted: boolean;
}

/** `event: reward-earned` — a tracker completed and minted a reward; same shape as a
 * `GET /api/rewards` entry. */
export type RewardEarnedPayload = RewardLedgerEntry;
