/** T-004 — `GET /api/customers`: the fixed 3-customer demo roster (TC-1), unfiltered. */
import { Router } from 'express';
import type { AppState } from './app-state';

export function createCustomersRouter(state: AppState): Router {
  const router = Router();

  router.get('/customers', (_req, res) => {
    res.status(200).json({ data: state.customers });
  });

  return router;
}
