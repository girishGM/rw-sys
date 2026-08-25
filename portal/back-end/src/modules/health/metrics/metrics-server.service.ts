/**
 * T-052 — the second listener `GET /metrics` lives on (08-OBSERVABILITY.md §8: "Metrics on a
 * separate, non-public port").
 *
 * **Why a second `http.Server` rather than a route on the main Nest application.** A route
 * under `api/v1` would inherit that port's exposure — published by `docker-compose.yml`,
 * reachable through whatever reverse proxy sits in front of it in a real deployment — and no
 * amount of `@Public()`/guard configuration changes which *port* a request arrived on. Putting
 * `/metrics` on its own `METRICS_PORT`, opened here rather than through Nest's own HTTP adapter,
 * means TC-10/TC-11's property ("reachable on the metrics port only; not reachable from outside
 * the container network") is true by construction — there is no route to disable, only a port
 * `docker-compose.yml` chooses not to publish (`docs/DEPLOYMENT.md`).
 *
 * **Why a lifecycle hook on a provider, not a line in `main.ts`.** `OnApplicationBootstrap`
 * runs once the whole module graph — including `DatabaseModule`, which `DbPoolSampler` needs —
 * has finished wiring up, and `main.ts` is a shared file no single task owns outright. A
 * self-starting provider keeps the whole feature inside this task's own file scope
 * (`back-end/src/modules/health/**`) instead of adding a line to a file every other Wave 4 task
 * also touches.
 *
 * Dependency-free by the same reasoning `metrics.registry.ts`'s header gives: Node's own `http`
 * module is enough for one route that never accepts a request body.
 */
import { createServer, type Server } from 'node:http';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.schema';
import { DbPoolSampler } from './db-pool.sampler';
import { MetricsRegistry } from './metrics.registry';

const DEFAULT_METRICS_PORT = 9464;
/** Prometheus's own exposition content type (see the format doc linked in `metrics.registry.ts`). */
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Pulled out as a pure function so the `METRICS_PORT` unset → `9464` fallback is unit-testable
 * without actually binding the real default port — flaky and unnecessary, given the sandbox
 * this file was verified in already had an unrelated process squatting on 9464 during this
 * very task (a concurrent e2e run — see this task's completion report). */
export function resolvePort(configured: number | undefined): number {
  return configured ?? DEFAULT_METRICS_PORT;
}

@Injectable()
export class MetricsServerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MetricsServerService.name);
  private server: Server | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly registry: MetricsRegistry,
    private readonly dbPool: DbPoolSampler,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('METRICS_ENABLED', { infer: true })) {
      this.logger.log('METRICS_ENABLED=false — the metrics listener was not opened.');
      return;
    }

    const port = resolvePort(this.config.get('METRICS_PORT', { infer: true }));
    const host = this.config.get('METRICS_HOST', { infer: true });

    this.server = createServer((request, response) => this.handle(request.url, response));
    this.server.on('error', (error) => {
      // Never throws out of a lifecycle hook — a metrics port that failed to bind (already in
      // use, no permission) must not take the whole application down with it.
      this.logger.error(`Metrics listener failed: ${error.message}`);
    });
    const onListening = (): void => {
      this.logger.log(`Metrics listener on ${host ?? '0.0.0.0'}:${port} (GET /metrics only)`);
    };
    // Node's `listen(port, host, callback)` overload does not tolerate an explicit `undefined`
    // host the way a caller might expect — calling the two-argument form when unset keeps "no
    // host configured" behaving exactly like Node's own documented default (all interfaces).
    if (host === undefined) {
      this.server.listen(port, onListening);
    } else {
      this.server.listen(port, host, onListening);
    }
  }

  /** The bound port, once listening — `null` before bootstrap, when disabled, or (in a test)
   * before the `listening` event has fired. Exists for `metrics-server.service.spec.ts` to
   * bind to an OS-assigned ephemeral port (`METRICS_PORT=0`) without hard-coding one. */
  get boundPort(): number | null {
    const address = this.server?.address();
    return address !== null && address !== undefined && typeof address === 'object'
      ? address.port
      : null;
  }

  /** Runs on the same SIGTERM/SIGINT `app.enableShutdownHooks()` already wires up in
   * `main.ts` — every `OnApplicationShutdown` provider in the graph gets this call, this one
   * included, with no separate signal handler needed. */
  onApplicationShutdown(): void {
    this.server?.close();
  }

  private handle(url: string | undefined, response: import('node:http').ServerResponse): void {
    if (url !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }

    const pool = this.dbPool.sample();
    if (pool?.utilisation !== null && pool?.utilisation !== undefined) {
      this.registry.setGauge('db_pool_utilisation', {}, pool.utilisation);
    }

    const body = this.registry.render();
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPE,
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  }
}
