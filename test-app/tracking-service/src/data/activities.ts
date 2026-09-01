/**
 * T-013 — per-customer activity history log. Filed as a defect against T-010 (Activity Simulator
 * page): that page needs a real feed of recent activity for the selected customer, and until this
 * task nothing persisted a `POST /api/activities` call anywhere — `routes/activities.ts` evaluated
 * and returned a result but never stored it, so there was no `GET` a feed could call. Every
 * `POST /api/activities` call now appends one entry here, matched or not, so the feed is a true
 * history rather than just the latest response.
 */
import type { RewardLedgerEntry } from './rewards';

/** One tracker-component's progress delta from a single activity. Field-for-field the same shape
 * `routes/activities.ts`'s `POST` response already reports (`ProgressDelta`) — duplicated here,
 * not imported from `routes/`, so `data/` never depends on `routes/` (matches every other module
 * in this folder: `progress.ts`/`rewards.ts` know nothing about the route layer either). */
export interface ActivityProgressDelta {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly campaignName: string;
  readonly trackerId: number;
  readonly trackerCode: string;
  readonly trackerName: string;
  readonly componentId: number;
  readonly completedCount: number;
  readonly threshold: number;
  readonly trackerCompleted: boolean;
}

export interface ActivityHistoryEntry {
  readonly id: string;
  readonly customerId: string;
  /** ISO 8601, set at the moment the activity was recorded. */
  readonly timestamp: string;
  readonly activityType: string;
  readonly merchant: string | null;
  readonly amount: number | null;
  /** Human-readable one-line summary for the feed — see {@link describeActivity}. */
  readonly description: string;
  readonly matched: boolean;
  readonly progress: readonly ActivityProgressDelta[];
  readonly rewards: readonly RewardLedgerEntry[];
}

/**
 * The "description" T-010's evidence asks for, alongside the raw `progress`/`rewards` arrays a
 * richer feed UI could still render from directly. Deterministic and pure so it's covered by a
 * plain unit test rather than only indirectly through the route.
 */
export function describeActivity(
  activityType: string,
  matched: boolean,
  rewards: readonly RewardLedgerEntry[],
): string {
  if (rewards.length > 0) {
    const types = rewards.map((reward) => reward.type).join(', ');
    return `${activityType} — reward earned (${types})`;
  }
  if (matched) {
    return `${activityType} — progress updated`;
  }
  return `${activityType} — no matching tracker`;
}

/** Keyed by {@link Customer.id}, same convention as `ProgressStore`/`RewardsStore`. */
export class ActivityHistoryStore {
  private readonly byCustomer = new Map<string, ActivityHistoryEntry[]>();

  /** Appends one entry — called once per `POST /api/activities`, matched or not, so the feed's
   * count of "things submitted" always matches reality even when nothing progressed. */
  addEntry(entry: ActivityHistoryEntry): void {
    const existing = this.byCustomer.get(entry.customerId) ?? [];
    this.byCustomer.set(entry.customerId, [...existing, entry]);
  }

  /** Most-recent-first — the exact order `GET /api/activities` returns and the feed renders
   * directly, no client-side re-sort needed. `[]`, never `undefined`, for a customer with no
   * history yet. */
  getForCustomer(customerId: string): readonly ActivityHistoryEntry[] {
    const entries = this.byCustomer.get(customerId) ?? [];
    return [...entries].reverse();
  }
}
