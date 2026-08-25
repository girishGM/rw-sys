import { get as httpGet } from 'node:http';
import type { ConfigService } from '@nestjs/config';
import { DbPoolSampler } from './db-pool.sampler';
import { MetricsRegistry } from './metrics.registry';
import { MetricsServerService, resolvePort } from './metrics-server.service';

describe('resolvePort', () => {
  it('returns the configured port when one is set', () => {
    expect(resolvePort(9999)).toBe(9999);
  });

  it('falls back to 9464 (the Prometheus/OTel convention) when unset', () => {
    expect(resolvePort(undefined)).toBe(9464);
  });
});

/** A real HTTP GET, because TC-10's property — "reachable on the metrics port" — is a claim
 * about a real socket accepting a real connection, not about a function call (AGENT-PROTOCOL
 * §3's "assert the observable property" note, applied to this task's own infrastructure). */
function get(
  port: number,
  path: string,
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const request = httpGet({ host: '127.0.0.1', port, path }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
      );
    });
    request.on('error', reject);
  });
}

function configWith(values: Record<string, unknown>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('MetricsServerService', () => {
  const started: MetricsServerService[] = [];

  afterEach(() => {
    started.forEach((service) => service.onApplicationShutdown());
    started.length = 0;
  });

  function bootServer(overrides: Record<string, unknown> = {}): MetricsServerService {
    const registry = new MetricsRegistry();
    const sampler = { sample: () => null } as unknown as DbPoolSampler;
    const config = configWith({ METRICS_ENABLED: true, METRICS_PORT: 0, ...overrides });
    const service = new MetricsServerService(config as never, registry, sampler);
    service.onApplicationBootstrap();
    started.push(service);
    return service;
  }

  it('serves GET /metrics with the Prometheus content type and a 200', async () => {
    const service = bootServer();
    await waitUntilListening(service);

    const response = await get(service.boundPort!, '/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('reflects registry state at scrape time', async () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter('auth_login_total', { result: 'success' }, 7);
    const sampler = { sample: () => null } as unknown as DbPoolSampler;
    const config = configWith({ METRICS_ENABLED: true, METRICS_PORT: 0 });
    const service = new MetricsServerService(config as never, registry, sampler);
    service.onApplicationBootstrap();
    started.push(service);
    await waitUntilListening(service);

    const response = await get(service.boundPort!, '/metrics');
    expect(response.body).toContain('auth_login_total{result="success"} 7');
  });

  it('samples the DB pool gauge into the response when the sampler has a reading', async () => {
    const registry = new MetricsRegistry();
    const sampler = {
      sample: () => ({ using: 5, available: 15, waiting: 0, maxSize: 20, utilisation: 0.25 }),
    } as unknown as DbPoolSampler;
    const config = configWith({ METRICS_ENABLED: true, METRICS_PORT: 0 });
    const service = new MetricsServerService(config as never, registry, sampler);
    service.onApplicationBootstrap();
    started.push(service);
    await waitUntilListening(service);

    const response = await get(service.boundPort!, '/metrics');
    expect(response.body).toContain('db_pool_utilisation 0.25');
  });

  it('returns 404 for any path other than /metrics', async () => {
    const service = bootServer();
    await waitUntilListening(service);

    const response = await get(service.boundPort!, '/anything-else');
    expect(response.status).toBe(404);
  });

  it('does not open a listener when METRICS_ENABLED=false', () => {
    const service = bootServer({ METRICS_ENABLED: false });
    expect(service.boundPort).toBeNull();
  });

  it('binds to an explicit METRICS_HOST when one is configured', async () => {
    const service = bootServer({ METRICS_HOST: '127.0.0.1' });
    await waitUntilListening(service);

    const response = await get(service.boundPort!, '/metrics');
    expect(response.status).toBe(200);
  });

  it('logs rather than throws when the listener fails to bind (e.g. the port is already in use)', async () => {
    const first = bootServer();
    await waitUntilListening(first);
    const takenPort = first.boundPort!;

    // A second service explicitly configured to bind the SAME already-listening port — the
    // real trigger for the server's own 'error' handler, not a mocked one.
    const registry = new MetricsRegistry();
    const sampler = { sample: () => null } as unknown as DbPoolSampler;
    const config = configWith({ METRICS_ENABLED: true, METRICS_PORT: takenPort });
    const second = new MetricsServerService(config as never, registry, sampler);

    expect(() => second.onApplicationBootstrap()).not.toThrow();
    started.push(second);
  });

  it('closes the listener on onApplicationShutdown, so a repeat scrape refuses the connection', async () => {
    const service = bootServer();
    await waitUntilListening(service);
    const port = service.boundPort!;

    service.onApplicationShutdown();

    await expect(get(port, '/metrics')).rejects.toBeDefined();
  });
});

function waitUntilListening(service: MetricsServerService): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (service.boundPort !== null) {
        resolve();
      } else {
        setImmediate(check);
      }
    };
    check();
  });
}
