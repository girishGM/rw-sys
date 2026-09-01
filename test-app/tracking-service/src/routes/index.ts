/** T-004 — mounts every `/api/*` route onto one `Router`, given a real (or fixture, in tests)
 * {@link AppState}. `app.ts` mounts the result at `/api`. */
import { Router } from 'express';
import type { AppState } from './app-state';
import { createActivitiesRouter } from './activities';
import { createCampaignsRouter } from './campaigns';
import { createCustomersRouter } from './customers';
import { createDashboardRouter } from './dashboard';
import { createEventsRouter } from './events';
import { createRewardsRouter } from './rewards';

export type { AppState } from './app-state';
export { SseHub } from './events';

export function createApiRouter(state: AppState): Router {
  const router = Router();
  router.use(createCustomersRouter(state));
  router.use(createDashboardRouter(state));
  router.use(createCampaignsRouter(state));
  router.use(createRewardsRouter(state));
  router.use(createActivitiesRouter(state));
  router.use(createEventsRouter(state));
  return router;
}
