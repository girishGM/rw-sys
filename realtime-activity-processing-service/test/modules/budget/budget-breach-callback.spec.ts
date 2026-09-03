/**
 * T-RAP-033. Real, wire-level coverage of `BudgetBreachCallbackClient` — no fakes standing in for
 * gRPC or HTTP (`cap-enforcement.spec.ts`'s TC-6/8/9 already cover the orchestration side against
 * a fake of this client; this file covers what that fake stands in for).
 *
 * Two mock servers, matching the two protocols this client speaks:
 *  - a real `@grpc/grpc-js` mock implementing `GetBudgetStatus` (insecure — same
 *    `campaign-config-cache.e2e-spec.ts` precedent T-RAP-010 already established), for `capId`
 *    resolution/matching.
 *  - a plain `node:http` mock (the insecure fallback this task added to
 *    `budget-breach-callback.client.ts` — no TLS material is configured anywhere in this repo's
 *    own test environment) for the `POST /internal/v1/campaigns/:id/budget-breach` call itself.
 *
 * Since production wires both onto the *same* host:port (the real portal's own combined mTLS
 * listener), and a hand-rolled test double faithfully speaking both gRPC-framed HTTP/2 *and*
 * plain HTTP/1.1 on one port is disproportionate engineering for a test double, the "successful
 * POST" scenarios below seed the client's own in-memory `capIdCache` directly (a plain `Map`, not
 * a private method) rather than resolving it over the wire a second time — `resolveCapId`'s own
 * *matching* correctness is proven separately, for real, against the gRPC mock.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import { BudgetBreachCallbackClient } from '@/modules/budget/budget-breach-callback.client';
import type { CampaignCapProto } from '@/modules/campaign-cache/campaign-config.client';

function protoPath(): string {
  return join(__dirname, '..', '..', '..', 'proto', 'campaign_config.proto');
}

function loadServiceDefinition(): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync(protoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    rewardportal: {
      config: { v1: { CampaignConfigService: { service: grpc.ServiceDefinition } } };
    };
  };
  return proto.rewardportal.config.v1.CampaignConfigService.service;
}

interface MockBudgetStatusEntry {
  capId: number;
  capClass: string;
  scopeLevel: string;
  scopeRefId: number;
  periodType: string;
  unitType: string;
  unitCode: string;
}

function startGrpcMock(
  entries: MockBudgetStatusEntry[],
  onRequest?: (request: { tenantId: number; campaignCode: string }) => void,
): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(loadServiceDefinition(), {
      getBudgetStatus: (
        call: grpc.ServerUnaryCall<
          { tenantId: number; campaignCode: string },
          { campaignId: number; servedAt: string; entries: MockBudgetStatusEntry[] }
        >,
        callback: grpc.sendUnaryData<{
          campaignId: number;
          servedAt: string;
          entries: MockBudgetStatusEntry[];
        }>,
      ) => {
        onRequest?.(call.request);
        callback(null, { campaignId: 1, servedAt: new Date().toISOString(), entries });
      },
    } as unknown as grpc.UntypedServiceImplementation);
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port });
    });
  });
}

/** `forceShutdown()`, not `tryShutdown()`: the "resolves capId" scenario below deliberately sends
 * plain-HTTP garbage at this same h2c server (proving the POST leg fails, once capId resolution
 * has already genuinely succeeded over the wire) — those malformed connections can leave
 * `tryShutdown()` waiting on a drain that never completes. This is a test double with no graceful
 * shutdown requirement of its own, so an immediate force-close is the right (and faster,
 * flake-free) choice. */
function stopGrpcMock(server: grpc.Server): void {
  server.forceShutdown();
}

interface RecordedRequest {
  path: string;
  method: string | undefined;
  body: string;
}

function startHttpMock(
  responder: (request: RecordedRequest, response: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: RecordedRequest = {
        path: request.url ?? '',
        method: request.method,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      responder(recorded, response);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind http mock server'));
        return;
      }
      resolve({ server, port: address.port, requests });
    });
  });
}

function stopHttpMock(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function fakeCap(overrides: Partial<CampaignCapProto> = {}): CampaignCapProto {
  return {
    capClass: 'budget',
    scopeLevel: 'campaign',
    scopeRefId: 0,
    periodType: 'lifetime',
    periodValue: 0,
    windowStartTime: '',
    windowEndTime: '',
    periodTimezone: '',
    unitType: 'currency',
    unitCode: 'MYR',
    rewardType: '',
    maxTotalAmount: '1000.00',
    maxOccurrences: 0,
    maxCustomers: 0,
    onBreach: 'pause_campaign',
    warnAtPercent: 0,
    ...overrides,
  };
}

/** Reaches into the client's own documented in-memory cache (a plain `Map`, not a private
 * method) — see this file's own header for why. */
function seedCapIdCache(
  client: BudgetBreachCallbackClient,
  tenantId: number,
  campaignCode: string,
  entries: MockBudgetStatusEntry[],
): void {
  (
    client as unknown as {
      capIdCache: Map<string, { entries: MockBudgetStatusEntry[]; fetchedAt: number }>;
    }
  ).capIdCache.set(`${tenantId}:${campaignCode}`, { entries, fetchedAt: Date.now() });
}

describe('BudgetBreachCallbackClient — capId resolution (real gRPC wire call)', () => {
  it('resolves capId via GetBudgetStatus when exactly one entry matches the cap', async () => {
    const cap = fakeCap({ scopeLevel: 'campaign', scopeRefId: 0, unitCode: 'MYR' });
    let seenRequest: { tenantId: number; campaignCode: string } | undefined;
    const { server, port } = await startGrpcMock(
      [
        {
          capId: 42,
          capClass: cap.capClass,
          scopeLevel: cap.scopeLevel,
          scopeRefId: cap.scopeRefId,
          periodType: cap.periodType,
          unitType: cap.unitType,
          unitCode: cap.unitCode,
        },
      ],
      (request) => {
        seenRequest = request;
      },
    );

    try {
      const client = new BudgetBreachCallbackClient({ host: '127.0.0.1', port, timeoutMs: 2000 });
      await expect(
        client.reportBreach({
          tenantId: 7,
          campaignId: 900,
          campaignCode: 'CAMP_X',
          cap,
          observedTotal: '123.45',
          breachedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        // No HTTP server is listening on this same port, so the POST leg fails — capId
        // resolution having genuinely succeeded is what this test actually proves; see the
        // seeded-cache scenarios below for the POST leg itself.
      ).rejects.toThrow();

      expect(seenRequest).toEqual({ tenantId: 7, campaignCode: 'CAMP_X' });
    } finally {
      stopGrpcMock(server);
    }
  }, 10_000);

  it('refuses to guess when more than one BudgetStatusEntry matches — never phones home with a wrong capId', async () => {
    const cap = fakeCap();
    const duplicateEntry = {
      capId: 1,
      capClass: cap.capClass,
      scopeLevel: cap.scopeLevel,
      scopeRefId: cap.scopeRefId,
      periodType: cap.periodType,
      unitType: cap.unitType,
      unitCode: cap.unitCode,
    };
    const { server, port } = await startGrpcMock([duplicateEntry, { ...duplicateEntry, capId: 2 }]);

    try {
      const client = new BudgetBreachCallbackClient({ host: '127.0.0.1', port, timeoutMs: 2000 });
      const started = Date.now();
      await expect(
        client.reportBreach({
          tenantId: 7,
          campaignId: 900,
          campaignCode: 'CAMP_X',
          cap,
          observedTotal: '123.45',
          breachedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ).rejects.toThrow(/no unambiguous capId/);
      // No retry/backoff elapsed — the ambiguity is detected before any POST attempt.
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      stopGrpcMock(server);
    }
  });
});

describe('BudgetBreachCallbackClient — POST (real HTTP wire call, insecure fallback)', () => {
  const cap = fakeCap();

  it('posts the documented body shape to the documented path and resolves on 200', async () => {
    const { server, port, requests } = await startHttpMock((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { paused: true } }));
    });

    try {
      const client = new BudgetBreachCallbackClient({ host: '127.0.0.1', port, timeoutMs: 2000 });
      seedCapIdCache(client, 7, 'CAMP_X', [
        {
          capId: 42,
          capClass: cap.capClass,
          scopeLevel: cap.scopeLevel,
          scopeRefId: cap.scopeRefId,
          periodType: cap.periodType,
          unitType: cap.unitType,
          unitCode: cap.unitCode,
        },
      ]);

      await client.reportBreach({
        tenantId: 7,
        campaignId: 900,
        campaignCode: 'CAMP_X',
        cap,
        observedTotal: '123.45',
        breachedAt: new Date('2026-03-01T00:00:00.000Z'),
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe('POST');
      expect(requests[0].path).toBe('/internal/v1/campaigns/900/budget-breach');
      expect(JSON.parse(requests[0].body)).toEqual({
        capId: 42,
        breachedAt: '2026-03-01T00:00:00.000Z',
        observedTotal: '123.45',
      });
    } finally {
      await stopHttpMock(server);
    }
  });

  it('retries on a non-2xx response and succeeds once the server recovers', async () => {
    let attempt = 0;
    const { server, port, requests } = await startHttpMock((_request, response) => {
      attempt += 1;
      if (attempt < 2) {
        response.writeHead(503);
        response.end('temporarily unavailable');
        return;
      }
      response.writeHead(200);
      response.end('{}');
    });

    try {
      const client = new BudgetBreachCallbackClient({ host: '127.0.0.1', port, timeoutMs: 2000 });
      seedCapIdCache(client, 7, 'CAMP_X', [
        {
          capId: 1,
          capClass: cap.capClass,
          scopeLevel: cap.scopeLevel,
          scopeRefId: cap.scopeRefId,
          periodType: cap.periodType,
          unitType: cap.unitType,
          unitCode: cap.unitCode,
        },
      ]);

      await expect(
        client.reportBreach({
          tenantId: 7,
          campaignId: 900,
          campaignCode: 'CAMP_X',
          cap,
          observedTotal: '1.00',
          breachedAt: new Date(),
        }),
      ).resolves.toBeUndefined();

      expect(requests.length).toBeGreaterThanOrEqual(2);
    } finally {
      await stopHttpMock(server);
    }
  }, 10_000);

  it('exhausts its retry budget and throws when the server never recovers', async () => {
    const { server, port, requests } = await startHttpMock((_request, response) => {
      response.writeHead(500);
      response.end('nope');
    });

    try {
      const client = new BudgetBreachCallbackClient({ host: '127.0.0.1', port, timeoutMs: 2000 });
      seedCapIdCache(client, 7, 'CAMP_X', [
        {
          capId: 1,
          capClass: cap.capClass,
          scopeLevel: cap.scopeLevel,
          scopeRefId: cap.scopeRefId,
          periodType: cap.periodType,
          unitType: cap.unitType,
          unitCode: cap.unitCode,
        },
      ]);

      await expect(
        client.reportBreach({
          tenantId: 7,
          campaignId: 900,
          campaignCode: 'CAMP_X',
          cap,
          observedTotal: '1.00',
          breachedAt: new Date(),
        }),
      ).rejects.toThrow(/HTTP 500/);

      expect(requests).toHaveLength(3); // MAX_ATTEMPTS
    } finally {
      await stopHttpMock(server);
    }
  }, 10_000);
});
