/** T-004 — `GET /api/rewards?customerId=`: that customer's full reward ledger (TC-4), exactly as
 * `RewardsStore` holds it (no filtering/sorting — the frontend groups by type/status itself,
 * ARCHITECTURE.md §4's "My Rewards" page). */
import { Router } from 'express';
import type { AppState } from './app-state';
import { requireCustomerId } from './validation';

export function createRewardsRouter(state: AppState): Router {
  const router = Router();

  router.get('/rewards', (req, res) => {
    if (!requireCustomerId(req.query.customerId, res)) return;
    const customerId = req.query.customerId as string;

    res.status(200).json({ data: state.rewards.getForCustomer(customerId) });
  });

  return router;
}
