import cors from 'cors';
import express, { Express, type ErrorRequestHandler } from 'express';
import { createApiRouter, type AppState } from './routes';

/**
 * T-004's own frontend dev origin — `test-app/frontend/vite.config.ts`'s `server.port`. The
 * frontend's `/api/*` calls are same-origin in dev (Vite proxies them to this service, per that
 * file's own comment), so this mostly guards a browser calling `tracking-service` directly (e.g.
 * `EventSource` against an absolute URL, bypassing the proxy) — this task's scope names CORS
 * explicitly, so it's configured for real rather than left wide open.
 */
const FRONTEND_DEV_ORIGIN = 'http://localhost:5174';

/**
 * Builds the Express application without starting a listener, so tests can exercise routes
 * via supertest without binding a real port. `state` is required — every route beyond `/health`
 * needs somewhere real to read/write (T-001's original bare health-check server had no such
 * state; T-004 is the task that gives it one, per this task's own file-scope note).
 */
export function createApp(state: AppState): Express {
  const app = express();

  app.use(cors({ origin: FRONTEND_DEV_ORIGIN }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/api', createApiRouter(state));

  const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    const message = err instanceof Error ? err.message : 'unexpected error';
    res.status(502).json({ error: message });
  };
  app.use(handleError);

  return app;
}
