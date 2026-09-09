/**
 * T-004 — everything a route handler needs, bundled into one object rather than reached for via
 * module-level singletons, so `app.ts`/tests can construct a fresh, isolated instance per server
 * (real, in `server.ts`) or per test (a fixture — see `test-support/fixtures.ts`).
 */
import type { ActivityHistoryStore } from '../data/activities';
import type { Customer } from '../data/customers';
import type { ProgressStore } from '../data/progress';
import type { RewardsStore } from '../data/rewards';
import type { PortalDataSource } from '../engine';
import type { PromoCodeClient } from '../promo-code-client';
import type { RapActivityClient } from '../rap-client';
import type { RapProgressReader } from '../rap-progress-client';
import type { RewardTrackingClient } from '../reward-tracking-client';
import type { SseHub } from './events';

export interface AppState {
  readonly customers: readonly Customer[];
  readonly progress: ProgressStore;
  readonly rewards: RewardsStore;
  /** T-013 — per-customer activity history, written to on every `POST /api/activities`. */
  readonly activities: ActivityHistoryStore;
  readonly portal: PortalDataSource;
  /** The real promo-code-service caller, or `null` when `PROMO_CODE_SERVICE_BASE_URL`/
   * `PROMO_CODE_SERVICE_GENERATION_TOKEN` are unset — see `promo-code-client/from-env.ts` and
   * `engine/reward.ts`'s fallback behaviour when this is `null`. */
  readonly promoCode: PromoCodeClient | null;
  /** The real realtime-activity-processing-service gRPC client, or `null` when
   * `RAP_GRPC_ENABLED=false` or misconfigured — see `rap-client/from-env.ts`. Every submitted
   * activity is also forwarded to RAP's real `SubmitActivity` RPC as a best-effort, additive side
   * call (`routes/activities.ts`); this can never affect this app's own in-memory engine result or
   * this endpoint's response — see that route's own comment on why. */
  readonly rap: RapActivityClient | null;
  /** T-INT-022 — the real reward-tracking-service caller for a customer's *confirmed* reward
   * summary (leg 7), or `null` when `CUSTOMER_API_AUTH_SECRET` is unset — see
   * `reward-tracking-client/from-env.ts`. `null` here means `routes/rewards.ts`'s own
   * `/rewards/confirmed` endpoint reports `status: 'not_configured'` rather than crashing; the
   * existing `rewards`/`RewardsStore` above stays this app's own optimistic ledger regardless (see
   * that route's own header for the full source-of-truth decision). */
  readonly rewardTracking: RewardTrackingClient | null;
  /** T-INT-021 — the real realtime-activity-processing-service ("RAP") caller for a customer's
   * real tracker/component progress (leg 2/finding 4), or `null` when `PROGRESS_API_AUTH_SECRET`
   * is unset — see `rap-progress-client/from-env.ts`. `null` here means `routes/dashboard.ts`'s
   * own `trackerProgress` entries all report `progressUnknown: true` rather than crashing;
   * `ProgressStore` (`progress` above) still supplies every *structural* field (ids, codes, names,
   * `completionLogic`) this route needs — only the `completed`/count fields move to being
   * RAP-sourced. */
  readonly rapProgress: RapProgressReader | null;
  readonly sse: SseHub;
}
