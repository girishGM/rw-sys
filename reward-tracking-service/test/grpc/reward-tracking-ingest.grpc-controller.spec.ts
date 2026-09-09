/**
 * T-RTS-011 — real round trip: a real `@grpc/grpc-js` client, over a real (plaintext) socket,
 * against a real, listening `GrpcServerRootModule` (`src/grpc/grpc-server.main.ts`'s own
 * composition root) backed by the real, already-migrated `reward_tracking` schema on the real
 * local Postgres 16 server (root `CLAUDE.md`) — same "assert the observable property, not the
 * implementation string" discipline `reward-redemption-service`'s own `reward-ingest.e2e-spec.ts`
 * (T-RR-011) and this service's own `reward-tracking-ingestion.service.spec.ts` (T-RTS-010)
 * already establish: only a real network round trip against a real server can actually prove
 * TC-3's gRPC status code and TC-4's "never logged" property, not a mocked transport.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { Logger } from '@nestjs/common';
import { createMigrationConnection } from '@/database/migration-connection';
import { MetricsService } from '@/observability/metrics.service';
import {
  createRewardTrackingGrpcServer,
  type RewardTrackingGrpcServerHandle,
} from '@/grpc/grpc-server.main';

jest.setTimeout(30000);

const TENANT_ID = 950_000 + Math.floor(Math.random() * 9_999);

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('failed to allocate a free port'));
      }
    });
  });
}

interface TestClient extends grpc.Client {
  IngestRewardTrackingEvent(
    request: Record<string, unknown>,
    callback: (error: grpc.ServiceError | null, response: { status: string }) => void,
  ): grpc.ClientUnaryCall;
}

function createTestClient(address: string): TestClient {
  const packageDefinition = protoLoader.loadSync(
    join(__dirname, '..', '..', 'proto', 'reward_tracking_ingest.proto'),
    { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true },
  );
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    rewardtracking: {
      ingest: { v1: { RewardTrackingIngestService: new (...args: unknown[]) => grpc.Client } };
    };
  };
  const Ctor = proto.rewardtracking.ingest.v1.RewardTrackingIngestService;
  return new Ctor(address, grpc.credentials.createInsecure()) as TestClient;
}

function callIngest(
  client: TestClient,
  request: Record<string, unknown>,
): Promise<{ status: string }> {
  return new Promise((resolve, reject) => {
    client.IngestRewardTrackingEvent(request, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

describe('T-RTS-011 — gRPC server (real socket, real Postgres) (e2e)', () => {
  let handle: RewardTrackingGrpcServerHandle;
  let db: Sequelize;
  let address: string;

  beforeAll(async () => {
    const port = await getFreePort();
    handle = await createRewardTrackingGrpcServer(port);
    address = `localhost:${port}`;

    db = createMigrationConnection();
    await db.authenticate();
  });

  afterAll(async () => {
    await db.query('DELETE FROM reward_tracking.reward_fact WHERE tenant_id = :tenantId', {
      type: QueryTypes.RAW,
      replacements: { tenantId: TENANT_ID },
    });
    await db.query(
      `DELETE FROM reward_tracking.inbound_event_log
         WHERE payload->>'tenantId' = :tenantIdStr`,
      { type: QueryTypes.RAW, replacements: { tenantIdStr: String(TENANT_ID) } },
    );
    await db.query(
      'DELETE FROM reward_tracking.customer_reward_ledger WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await db.query(
      'DELETE FROM reward_tracking.campaign_reward_counter_shard WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await db.close();
    await handle.close();
  });

  function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      rewardEntryId: randomUUID(),
      correlationId: randomUUID(),
      tenantId: TENANT_ID,
      tenantCode: 'T1',
      countryCode: 'US',
      customerId: `customer-${randomUUID()}`,
      campaignCode: `CAMP-${randomUUID().slice(0, 8)}`,
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      merchantCode: '',
      rewardCode: 'RWD1',
      rewardCategory: 'CASHBACK',
      rewardKind: 'FIXED_AMOUNT',
      unitType: 'CURRENCY',
      unitCode: 'USD',
      rewardValue: '5.00',
      rewardValueUnit: 'USD',
      externalSystemCode: '',
      externalReferenceId: '',
      promoCodeConfigId: '',
      promoCodeConfigVersionNo: 0,
      redeemedAt: new Date().toISOString(),
      expiresAt: '',
      ...overrides,
    };
  }

  async function countRewardFact(rewardEntryId: string): Promise<number> {
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: rewardEntryId } },
    );
    return Number(rows[0].count);
  }

  // TC-1
  it("TC-1: a well-formed, fresh IngestRewardTrackingEvent call returns {status: 'applied'} and creates a reward_fact row", async () => {
    const client = createTestClient(address);
    const request = baseRequest();

    const response = await callIngest(client, request);

    expect(response.status).toBe('applied');
    expect(await countRewardFact(request.rewardEntryId as string)).toBe(1);
    client.close();
  });

  // TC-2
  it("TC-2: the identical call repeated returns {status: 'duplicate'} and creates no new row", async () => {
    const client = createTestClient(address);
    const request = baseRequest();

    const first = await callIngest(client, request);
    const second = await callIngest(client, request);

    expect(first.status).toBe('applied');
    expect(second.status).toBe('duplicate');
    expect(await countRewardFact(request.rewardEntryId as string)).toBe(1);
    client.close();
  });

  // TC-3
  it('TC-3: a malformed request (missing a required field) is rejected with INVALID_ARGUMENT and nothing is written', async () => {
    const client = createTestClient(address);
    const request = baseRequest({ campaignCode: '' });

    await expect(callIngest(client, request)).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    expect(await countRewardFact(request.rewardEntryId as string)).toBe(0);
    client.close();
  });

  it('TC-3b: a request missing tenant_id is rejected with INVALID_ARGUMENT', async () => {
    const client = createTestClient(address);
    const request = baseRequest({ tenantId: 0 });

    await expect(callIngest(client, request)).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    client.close();
  });

  it('TC-3c: an unparseable redeemed_at is rejected with INVALID_ARGUMENT', async () => {
    const client = createTestClient(address);
    const request = baseRequest({ redeemedAt: 'not-a-date' });

    await expect(callIngest(client, request)).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    client.close();
  });

  // T-INT-050 — TC-2: `reward_value_unit` empty/absent must not be rejected (a `PROMO_CODE`/
  // `POINTS`-kind reward has no fixed unit by design). Regression for the T-INT-040 evidence.
  it("TC-2 (T-INT-050): reward_value_unit as an empty string is accepted, creates a reward_fact row with reward_value_unit = ''", async () => {
    const client = createTestClient(address);
    const request = baseRequest({ rewardValueUnit: '' });

    const response = await callIngest(client, request);

    expect(response.status).toBe('applied');
    const [row] = await db.query<{ reward_value_unit: string }>(
      'SELECT reward_value_unit FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: request.rewardEntryId } },
    );
    expect(row.reward_value_unit).toBe('');
    client.close();
  });

  // TC-4
  it('TC-4: customerId never appears in any log line during a call', async () => {
    const captured: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => JSON.stringify(arg)).join(' '));
      }),
    );
    // T-RTS-049: this class's own log lines now go through `StructuredLogger` (console-based),
    // not Nest's `Logger` — captured here too so this test can still fail if a future change
    // reintroduces a plaintext `customerId` into either logging path.
    const consoleSpies = (['log', 'warn', 'error', 'debug'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(' '));
      }),
    );

    try {
      const client = createTestClient(address);
      const request = baseRequest();

      await callIngest(client, request);
      // Also exercise the error path, which must equally never log the plaintext customerId.
      await callIngest(client, baseRequest({ campaignCode: '' })).catch(() => undefined);

      client.close();

      const allLogText = captured.join('\n');
      expect(allLogText).not.toContain(request.customerId as string);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });

  // T-RTS-049 — defect regression: this channel's own catch block must increment
  // reward_tracking_events_ingested_total{channel:'GRPC', outcome:'failed'} and emit a structured
  // log carrying correlationId as a separate field, for BOTH a client validation error and (via
  // `applyRewardTrackingEvent()`'s own success-path increment) a normal applied ingest. Proven red
  // against the pre-fix code (see this task's own completion report) before this fix landed.
  describe('T-RTS-049 — observability wiring', () => {
    it("TC-2: increments reward_tracking_events_ingested_total{channel:'GRPC', outcome:'applied'} on a fresh ingest", async () => {
      const metrics = handle.appContext.get(MetricsService);
      const before = metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'GRPC',
        outcome: 'applied',
      });
      const client = createTestClient(address);
      const request = baseRequest();

      await callIngest(client, request);
      client.close();

      expect(
        metrics.getCounterValue('reward_tracking_events_ingested_total', {
          channel: 'GRPC',
          outcome: 'applied',
        }),
      ).toBe(before + 1);
    });

    it("TC-2/TC-3: increments outcome:'failed' and logs correlationId on a rejected (INVALID_ARGUMENT) request", async () => {
      const metrics = handle.appContext.get(MetricsService);
      const before = metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'GRPC',
        outcome: 'failed',
      });
      const logSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const client = createTestClient(address);
        const request = baseRequest({ campaignCode: '' });

        await expect(callIngest(client, request)).rejects.toMatchObject({
          code: grpc.status.INVALID_ARGUMENT,
        });
        client.close();

        expect(
          metrics.getCounterValue('reward_tracking_events_ingested_total', {
            channel: 'GRPC',
            outcome: 'failed',
          }),
        ).toBe(before + 1);

        const entries = logSpy.mock.calls
          .map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
          .filter((entry) => entry.context === 'RewardTrackingIngestGrpcController');
        expect(entries).toHaveLength(1);
        expect(entries[0].correlationId).toBe(request.correlationId);
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
