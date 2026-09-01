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
import type { SseHub } from './events';

export interface AppState {
  readonly customers: readonly Customer[];
  readonly progress: ProgressStore;
  readonly rewards: RewardsStore;
  /** T-013 — per-customer activity history, written to on every `POST /api/activities`. */
  readonly activities: ActivityHistoryStore;
  readonly portal: PortalDataSource;
  readonly sse: SseHub;
}
