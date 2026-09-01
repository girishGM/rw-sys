/**
 * T-004 — `GET /api/events`: Server-Sent Events, one open connection per customer is enough for a
 * demo (this task's implementation notes) — a simple in-memory `Map<customerId, Set<Response>>`,
 * not a pub/sub layer. `routes/activities.ts` is the only other module that calls `SseHub.emit`.
 */
import { Router, type Response } from 'express';
import type { AppState } from './app-state';
import { requireCustomerId } from './validation';

export class SseHub {
  private readonly byCustomer = new Map<string, Set<Response>>();

  /** Registers `res` as an open SSE connection for `customerId`. Returns an unsubscribe function
   * the caller must run on `req`'s `close` event — an SSE connection an Express handler never
   * releases is a real leak, not just an unused variable. */
  subscribe(customerId: string, res: Response): () => void {
    const connections = this.byCustomer.get(customerId) ?? new Set<Response>();
    connections.add(res);
    this.byCustomer.set(customerId, connections);
    return () => {
      connections.delete(res);
      if (connections.size === 0) this.byCustomer.delete(customerId);
    };
  }

  /** Writes one SSE event to every open connection for `customerId`. A silent no-op — not an
   * error — when that customer has none open (TC-10: another customer's activity must never leak
   * onto this one's connection, and the reverse — nobody listening — must never throw). */
  emit(customerId: string, event: string, data: unknown): void {
    const connections = this.byCustomer.get(customerId);
    if (!connections) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of connections) {
      res.write(payload);
    }
  }

  /** Test/diagnostic use only — not read by any route handler. */
  connectionCount(customerId: string): number {
    return this.byCustomer.get(customerId)?.size ?? 0;
  }
}

export function createEventsRouter(state: AppState): Router {
  const router = Router();

  router.get('/events', (req, res) => {
    if (!requireCustomerId(req.query.customerId, res)) return;
    const customerId = req.query.customerId as string;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Forces the headers to actually flush and gives a curl/EventSource client immediate,
    // observable proof the connection is open (this task's verification step 2) rather than
    // waiting for the first real event, which may be a long time from now in a live demo.
    res.write(': connected\n\n');

    const unsubscribe = state.sse.subscribe(customerId, res);
    req.on('close', () => {
      unsubscribe();
    });
  });

  return router;
}
