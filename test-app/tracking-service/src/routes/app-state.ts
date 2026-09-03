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
  readonly sse: SseHub;
}
