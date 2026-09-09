/**
 * T-INT-006. Real, wire-level coverage of `RewardRestFallbackClient` — no fake standing in for
 * `fetch` (`outbox-publisher.spec.ts` already covers the orchestration side against a fake of this
 * client; this file covers what that fake stands in for), same "a real HTTP server, not a mock of
 * `fetch`" precedent `reward-grpc-fallback.spec.ts` already established for this leg's gRPC option.
 *
 * Uses Node's own `http` module to stand in for reward-redemption-service's real
 * `POST /api/v1/reward-entries` endpoint — this repo has no dependency on a heavier HTTP mocking
 * library anywhere, matching `campaign-config.client.ts`'s own precedent of testing native `fetch`
 * against a real, locally-bound server rather than intercepting the `fetch` call itself.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  RewardRestFallbackClient,
  REWARD_ENTRIES_INGEST_PATH,
  type RewardRestFallbackClientOptions,
} from '@/modules/dispatch/reward-rest-fallback.client';
import type { RewardEntryGrpcPayload } from '@/modules/dispatch/reward-grpc-fallback.client';

function samplePayload(overrides: Partial<RewardEntryGrpcPayload> = {}): RewardEntryGrpcPayload {
  return {
    id: 'reward-entry-1',
    correlationId: 'corr-1',
    tenantId: 1,
    customerId: 'CUST-1',
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: new Date().toISOString(),
    transactionType: '',
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '10.0000',
    activityValueUnit: 'MYR',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    campaignCode: 'CAMP1',
    trackerCode: 'TRK1',
    trackerComponentCode: 'COMP1',
    merchantCode: '',
    rewardCode: 'RWD1',
    rewardCategory: 'cashback',
    rewardValue: '10.00',
    rewardValueUnit: 'MYR',
    rewardEntryDate: new Date().toISOString(),
    completionCycle: 1,
    ...overrides,
  };
}

type Handler = (req: http.IncomingMessage, body: unknown) => { status: number; body?: unknown };

function startMockServer(handler: Handler): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsedBody = raw ? JSON.parse(raw) : undefined;
        const { status, body } = handler(req, parsedBody);
        res.statusCode = status;
        if (body !== undefined) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        } else {
          res.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function optionsFor(port: number): RewardRestFallbackClientOptions {
  return { baseUrl: `http://127.0.0.1:${port}`, token: 'test-token', timeoutMs: 2000 };
}

describe('T-INT-006 — RewardRestFallbackClient (real HTTP wire, local mock server)', () => {
  it('TC-3: submitRewardEntry resolves with {rewardEntryId, status} on a real 200 response', async () => {
    const seenRequests: { path: string; auth: string | undefined; body: unknown }[] = [];
    const { server, port } = await startMockServer((req, body) => {
      seenRequests.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      return { status: 200, body: { rewardEntryId: 'reward-entry-1', status: 'received' } };
    });
    const client = new RewardRestFallbackClient(optionsFor(port));

    try {
      const ack = await client.submitRewardEntry(samplePayload());
      expect(ack).toEqual({ rewardEntryId: 'reward-entry-1', status: 'received' });
      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0].path).toBe(REWARD_ENTRIES_INGEST_PATH);
      expect(seenRequests[0].auth).toBe('Bearer test-token');
      expect((seenRequests[0].body as RewardEntryGrpcPayload).customerId).toBe('CUST-1');
    } finally {
      server.close();
    }
  });

  it('re-encodes transactionType/activityCode/merchantCode from "" to null on the wire (RR\'s own requestSchema rejects "")', async () => {
    // Real bug this task's own live verification against a running reward-entries.controller.ts
    // caught: RR's zod schema is `z.string().min(1).nullable().optional()` for these three fields —
    // it accepts null/absent but rejects "" outright. `samplePayload()`'s own gRPC/Kafka-shaped ''
    // sentinel (proto3's "empty string means absent" convention) must never reach the wire as-is.
    const seenRequests: { body: unknown }[] = [];
    const { server, port } = await startMockServer((_req, body) => {
      seenRequests.push({ body });
      return { status: 200, body: { rewardEntryId: 'reward-entry-1', status: 'received' } };
    });
    const client = new RewardRestFallbackClient(optionsFor(port));

    try {
      await client.submitRewardEntry(
        samplePayload({ transactionType: '', activityCode: 'PURCHASE', merchantCode: '' }),
      );
      const sentBody = seenRequests[0].body as Record<string, unknown>;
      expect(sentBody.transactionType).toBeNull();
      expect(sentBody.merchantCode).toBeNull();
      // A genuinely-populated optional field passes through unchanged, never rewritten to null.
      expect(sentBody.activityCode).toBe('PURCHASE');
    } finally {
      server.close();
    }
  });

  it('a duplicate-id 200 response (RR never answers this endpoint with Conflict) is treated as success too', async () => {
    const { server, port } = await startMockServer(() => ({
      status: 200,
      body: { rewardEntryId: 'reward-entry-1', status: 'duplicate' },
    }));
    const client = new RewardRestFallbackClient(optionsFor(port));

    try {
      const ack = await client.submitRewardEntry(samplePayload());
      expect(ack.status).toBe('duplicate');
    } finally {
      server.close();
    }
  });

  it('rejects on a non-2xx HTTP status', async () => {
    const { server, port } = await startMockServer(() => ({
      status: 401,
      body: { message: 'invalid token' },
    }));
    const client = new RewardRestFallbackClient(optionsFor(port));

    try {
      await expect(client.submitRewardEntry(samplePayload())).rejects.toThrow(/401/);
    } finally {
      server.close();
    }
  });

  it('rejects on a 200 response with an unexpected/empty body shape', async () => {
    const { server, port } = await startMockServer(() => ({ status: 200, body: {} }));
    const client = new RewardRestFallbackClient(optionsFor(port));

    try {
      await expect(client.submitRewardEntry(samplePayload())).rejects.toThrow(/unexpected body/);
    } finally {
      server.close();
    }
  });

  it('TC-4: rejects (rather than hangs) when nothing is listening on the target port', async () => {
    const client = new RewardRestFallbackClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 'test-token',
      timeoutMs: 800,
    });

    await expect(client.submitRewardEntry(samplePayload())).rejects.toThrow();
  });

  it('loadRewardRestFallbackClientOptions throws a descriptive error when REWARD_REDEMPTION_REST_TOKEN is unset', async () => {
    const previous = process.env.REWARD_REDEMPTION_REST_TOKEN;
    delete process.env.REWARD_REDEMPTION_REST_TOKEN;
    try {
      const { loadRewardRestFallbackClientOptions } =
        await import('@/modules/dispatch/reward-rest-fallback.client');
      expect(() => loadRewardRestFallbackClientOptions()).toThrow(/REWARD_REDEMPTION_REST_TOKEN/);
    } finally {
      if (previous === undefined) {
        delete process.env.REWARD_REDEMPTION_REST_TOKEN;
      } else {
        process.env.REWARD_REDEMPTION_REST_TOKEN = previous;
      }
    }
  });
});
