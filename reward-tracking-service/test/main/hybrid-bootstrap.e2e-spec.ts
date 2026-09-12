/**
 * T-INT-005 — the hybrid bootstrap (`src/main.ts`), exercised as a REAL process would use it: real
 * `bootstrap()` calls (not a mocked transport), real Postgres (root `CLAUDE.md`), a real local
 * Redpanda broker for TC-3 (this task's own Verification step 1 already assumes one is running —
 * same assumption every other Kafka-touching spec in this service's own suite makes), and a real
 * `@grpc/grpc-js` mock portal server for TC-5/TC-6/TC-7 (same technique
 * `test/campaign-cache/campaign-hierarchy.client.spec.ts`, T-RTS-020, already established for this
 * exact contract — reused here at the hybrid-bootstrap level rather than the bare-client level).
 *
 * `src/main.ts` exports `bootstrap()` (T-INT-005's own addition, guarded by
 * `if (require.main === module)` at the bottom so importing it here — unlike before this task —
 * never self-invokes a real process against whatever `process.env` this file happens to leave
 * behind) and returns a `HybridBootstrapHandle` carrying every transport this call actually
 * started, plus one `close()` that tears all of them down — this file's own `afterEach` calls it
 * after every test so ports/connections never leak into the next one.
 *
 * Each `it()` mutates `process.env` for exactly the gate(s)/portal config it needs and restores
 * every touched key afterward (this file's own `ENV_KEYS`/`afterEach`) — `ConfigModule.forRoot`'s
 * own `PORT`/`DB_*`/`KAFKA_BROKERS` validation already ran once, at this file's own top-level
 * `import { bootstrap } from '@/main'`, so those stay fixed at `.env.development`'s values for
 * every test in this file; only the vars `main.ts`'s own hybrid-bootstrap logic and
 * `campaign-hierarchy.client.ts` read directly from `process.env` at call time are the ones this
 * file varies per test.
 *
 * **T-INT-057 update:** `HybridBootstrapHandle.restIngest` (a second app/port handle) is gone —
 * `RewardTrackingIngestController`'s routes are now mounted on `handle.app`/`handle.port`, the same
 * listener `/health` answers on (Render exposes exactly one port per `web` service; a second port
 * was never reachable there). TC-1 below now also asserts a real 404 for the ingest route on the
 * primary listener when the gate is off (this task's own TC-2), and TC-4 asserts the route is
 * reachable — and a bad token still 401s (this task's own TC-3) — on that same primary listener
 * instead of a separately-booted one.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, connect as netConnect } from 'node:net';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Kafka, logLevel } from 'kafkajs';
import request from 'supertest';
import { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  loadPortalAdminAuthSecret,
  signPortalAdminToken,
} from '@/modules/auth/portal-admin-auth.guard';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-hierarchy.client';
import { REWARD_TRACKING_COMPLETED_TOPIC } from '@/kafka/reward-tracking-consumer.service';
import { bootstrap, type HybridBootstrapHandle } from '@/main';

jest.setTimeout(60000);

const TENANT_ID_BASE = 990_000 + Math.floor(Math.random() * 9_000);

// -------------------------------------------------------------------------------------------
// Generic helpers.
// -------------------------------------------------------------------------------------------

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

/** Real TCP probe (not a mock) — resolves `true` only on an actual accepted connection. */
function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor: condition never became true within the timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// -------------------------------------------------------------------------------------------
// gRPC ingest test client (TC-2) — mirrors test/grpc/reward-tracking-ingest.grpc-controller.spec.ts.
// -------------------------------------------------------------------------------------------

interface IngestTestClient extends grpc.Client {
  IngestRewardTrackingEvent(
    req: Record<string, unknown>,
    callback: (error: grpc.ServiceError | null, response: { status: string }) => void,
  ): grpc.ClientUnaryCall;
}

function createIngestTestClient(address: string): IngestTestClient {
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
  return new Ctor(address, grpc.credentials.createInsecure()) as IngestTestClient;
}

function callIngest(
  client: IngestTestClient,
  req: Record<string, unknown>,
): Promise<{ status: string }> {
  return new Promise((resolve, reject) => {
    client.IngestRewardTrackingEvent(req, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

function grpcIngestBody(
  tenantId: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rewardEntryId: randomUUID(),
    correlationId: randomUUID(),
    tenantId,
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

/** Same event shape, JSON/REST-and-Kafka convention (`null`, not `''`, for an absent optional
 * field) — matches `validBody()`/`reward-tracking-ingest.dto.ts`'s own optional-field parsing. */
function jsonIngestBody(
  tenantId: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rewardEntryId: randomUUID(),
    correlationId: randomUUID(),
    tenantId,
    tenantCode: 'T1',
    countryCode: 'US',
    customerId: `customer-${randomUUID()}`,
    campaignCode: `CAMP-${randomUUID().slice(0, 8)}`,
    trackerCode: 'TRK1',
    trackerComponentCode: 'COMP1',
    merchantCode: null,
    rewardCode: 'RWD1',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'CURRENCY',
    unitCode: 'USD',
    rewardValue: '5.00',
    rewardValueUnit: 'USD',
    externalSystemCode: null,
    externalReferenceId: null,
    promoCodeConfigId: null,
    promoCodeConfigVersionNo: null,
    redeemedAt: new Date().toISOString(),
    expiresAt: null,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// Mock portal gRPC server (TC-5/TC-6/TC-7) — trimmed port of
// test/campaign-cache/campaign-hierarchy.client.spec.ts's own mock server, reused at the
// hybrid-bootstrap level instead of the bare-client level.
// -------------------------------------------------------------------------------------------

interface MockPortalState {
  campaignsByTenant: Map<number, CampaignConfigProto[]>;
}

function unimplemented(callback: grpc.sendUnaryData<unknown>): void {
  callback({
    name: 'Unimplemented',
    message: 'not used by T-INT-005',
    code: grpc.status.UNIMPLEMENTED,
  });
}

function campaignConfigProtoPath(): string {
  return join(
    __dirname,
    '..',
    '..',
    'src',
    'modules',
    'campaign-cache',
    'proto',
    'campaign_config.proto',
  );
}

function loadCampaignConfigServiceDefinition(): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync(campaignConfigProtoPath(), {
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

function buildMockPortalHandlers(state: MockPortalState): grpc.UntypedServiceImplementation {
  return {
    listActiveCampaigns: (
      call: grpc.ServerUnaryCall<{ tenantId: number }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      const campaigns = state.campaignsByTenant.get(call.request.tenantId) ?? [];
      callback(null, {
        campaigns,
        servedAt: new Date().toISOString(),
        sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS'],
        sectionsOmitted: ['RULES', 'REWARDS', 'CAPS'],
      });
    },
    getCampaignConfig: (
      call: grpc.ServerUnaryCall<{ tenantId: number; campaignCode: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      const campaigns = state.campaignsByTenant.get(call.request.tenantId) ?? [];
      const found = campaigns.find((c) => c.campaignCode === call.request.campaignCode);
      if (!found) {
        callback({ name: 'NotFound', message: 'campaign not found', code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, found);
    },
    // This suite only needs the cold-start warm cycle (ListActiveCampaigns) — no invalidation
    // event is ever written, so the stream just stays open until cancelled on shutdown, mirroring
    // campaign-hierarchy.client.spec.ts's own "never writes" watch handler.
    watchCampaignConfig: (call: grpc.ServerWritableStream<{ tenantId: number }, unknown>) => {
      call.on('cancelled', () => call.end());
    },
    resolveRuleVersion: (_c: unknown, cb: grpc.sendUnaryData<unknown>) => unimplemented(cb),
    resolveRewardVersion: (_c: unknown, cb: grpc.sendUnaryData<unknown>) => unimplemented(cb),
    getBudgetStatus: (_c: unknown, cb: grpc.sendUnaryData<unknown>) => unimplemented(cb),
  } as unknown as grpc.UntypedServiceImplementation;
}

function startMockPortal(state: MockPortalState): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(loadCampaignConfigServiceDefinition(), buildMockPortalHandlers(state));
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port });
    });
  });
}

function stopMockPortal(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}

/** A port nothing is listening on — bind an ephemeral server, note its port, shut it down
 * immediately. Standing in for "the portal is unreachable" (TC-7). */
async function unreachablePort(): Promise<number> {
  const { server, port } = await startMockPortal({ campaignsByTenant: new Map() });
  await stopMockPortal(server);
  return port;
}

function buildMockCampaign(tenantId: number, campaignCode: string): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode,
    tenantId,
    countryId: 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    budget: { amount: '1000.00', currency: 'USD' },
    maxParticipants: 100,
    merchants: [],
    trackers: [],
    rules: [],
    rewards: [],
    caps: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS'],
    sectionsOmitted: ['RULES', 'REWARDS', 'CAPS'],
  };
}

// -------------------------------------------------------------------------------------------
// Suite.
// -------------------------------------------------------------------------------------------

const ENV_KEYS = [
  'RTS_GRPC_INGEST_ENABLED',
  'RTS_GRPC_INGEST_PORT',
  'KAFKA_CONSUMER_ENABLED',
  'RTS_REST_INGEST_ENABLED',
  'RTS_REST_INGEST_PORT',
  'REWARD_TRACKING_INGEST_TOKEN',
  'PORTAL_GRPC_HOST',
  'PORTAL_GRPC_PORT',
  'PORTAL_CONFIG_TENANT_IDS',
] as const;

describe('T-INT-005 — hybrid bootstrap (real process, real Postgres) (e2e)', () => {
  let handle: HybridBootstrapHandle | null = null;
  let db: Sequelize;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const usedTenantIds: number[] = [];

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    db = createMigrationConnection();
    await db.authenticate();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  afterAll(async () => {
    for (const tenantId of usedTenantIds) {
      await db.query('DELETE FROM reward_tracking.reward_fact WHERE tenant_id = :tenantId', {
        type: QueryTypes.RAW,
        replacements: { tenantId },
      });
      await db.query(
        `DELETE FROM reward_tracking.inbound_event_log WHERE payload->>'tenantId' = :tenantIdStr`,
        { type: QueryTypes.RAW, replacements: { tenantIdStr: String(tenantId) } },
      );
      await db.query(
        'DELETE FROM reward_tracking.customer_reward_ledger WHERE tenant_id = :tenantId',
        { type: QueryTypes.RAW, replacements: { tenantId } },
      );
      await db.query(
        'DELETE FROM reward_tracking.campaign_reward_counter_shard WHERE tenant_id = :tenantId',
        { type: QueryTypes.RAW, replacements: { tenantId } },
      );
      await db.query(
        'DELETE FROM reward_tracking.campaign_hierarchy_cache WHERE tenant_id = :tenantId',
        { type: QueryTypes.RAW, replacements: { tenantId } },
      );
    }
    await db.close();
  });

  function nextTenantId(): number {
    const id = TENANT_ID_BASE + usedTenantIds.length;
    usedTenantIds.push(id);
    return id;
  }

  /** TC-1..TC-4 don't care about `CampaignCacheModule`'s own warm cycle — deleting
   * `PORTAL_CONFIG_TENANT_IDS` makes `resolveConfiguredTenantIds()` throw synchronously inside
   * `onModuleInit`'s own try/catch (no network attempt at all), keeping these tests fast and
   * independent of whether a real portal happens to be reachable at the default host/port. */
  function disableCampaignCacheWarm(): void {
    delete process.env.PORTAL_CONFIG_TENANT_IDS;
  }

  // TC-1
  it('TC-1: boots with all three transport gates unset — only the primary HTTP listener opens; existing REST APIs still respond', async () => {
    disableCampaignCacheWarm();
    delete process.env.RTS_GRPC_INGEST_ENABLED;
    delete process.env.KAFKA_CONSUMER_ENABLED;
    delete process.env.RTS_REST_INGEST_ENABLED;
    const grpcProbePort = await getFreePort();
    const restProbePort = await getFreePort();
    process.env.RTS_GRPC_INGEST_PORT = String(grpcProbePort);
    process.env.RTS_REST_INGEST_PORT = String(restProbePort);

    handle = await bootstrap();

    expect(handle.grpc).toBeNull();
    expect(handle.kafka).toBeNull();
    expect(handle.restIngestMounted).toBe(false);

    const healthResponse = await request(handle.app.getHttpServer()).get('/health');
    expect(healthResponse.status).toBe(200);

    // T-INT-057 TC-2: a true 404 on the primary listener — no route registered at all, not an
    // auth rejection — matching today's genuinely-unconfigured behavior exactly.
    const ingestProbe = await request(handle.app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .send({});
    expect(ingestProbe.status).toBe(404);

    await expect(isPortListening(grpcProbePort)).resolves.toBe(false);
    await expect(isPortListening(restProbePort)).resolves.toBe(false);
  });

  // TC-2
  it('TC-2: gRPC ingest gate on — RewardTrackingIngestService.IngestRewardTrackingEvent reachable via a real gRPC client', async () => {
    disableCampaignCacheWarm();
    const port = await getFreePort();
    process.env.RTS_GRPC_INGEST_ENABLED = 'true';
    process.env.RTS_GRPC_INGEST_PORT = String(port);

    handle = await bootstrap();
    expect(handle.grpc).not.toBeNull();
    expect(handle.grpc?.port).toBe(port);

    const tenantId = nextTenantId();
    const client = createIngestTestClient(`localhost:${port}`);
    try {
      const response = await callIngest(client, grpcIngestBody(tenantId));
      expect(response.status).toBe('applied');
    } finally {
      client.close();
    }
  });

  // TC-3
  it('TC-3: Kafka consumer gate on + local Redpanda — a message on reward.redemption.completed.v1 is consumed and lands in reward_fact', async () => {
    disableCampaignCacheWarm();
    process.env.KAFKA_CONSUMER_ENABLED = 'true';

    handle = await bootstrap();
    expect(handle.kafka).not.toBeNull();

    const tenantId = nextTenantId();
    const body = jsonIngestBody(tenantId);
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9095').split(',');
    const kafka = new Kafka({
      clientId: 'hybrid-bootstrap-e2e-spec-producer',
      brokers,
      logLevel: logLevel.NOTHING,
    });
    const producer = kafka.producer();
    await producer.connect();
    try {
      await producer.send({
        topic: REWARD_TRACKING_COMPLETED_TOPIC,
        messages: [{ key: body.customerId as string, value: JSON.stringify(body) }],
      });
    } finally {
      await producer.disconnect();
    }

    await waitFor(async () => {
      const rows = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
        { type: QueryTypes.SELECT, replacements: { id: body.rewardEntryId } },
      );
      return Number(rows[0].count) === 1;
    }, 20000);
  });

  // TC-4 (T-INT-057: reachable on the SAME port/listener as /health — no second port)
  it('TC-4: REST ingest gate on — POST /internal/reward-tracking-events reachable on the primary listener, same port as /health', async () => {
    disableCampaignCacheWarm();
    // Deliberately NOT set — T-INT-057's whole point is that the hybrid bootstrap no longer reads
    // this var at all; leaving it unset (and even pointed elsewhere) proves the ingest route is
    // reached via the primary `handle.port`, not some other port this variable might suggest.
    delete process.env.RTS_REST_INGEST_PORT;
    process.env.RTS_REST_INGEST_ENABLED = 'true';
    process.env.REWARD_TRACKING_INGEST_TOKEN = 'hybrid-bootstrap-e2e-spec-token';

    handle = await bootstrap();
    expect(handle.restIngestMounted).toBe(true);

    // TC-1 (this task's own): reachable on the exact same port/listener `/health` responds on.
    const healthResponse = await request(handle.app.getHttpServer()).get('/health');
    expect(healthResponse.status).toBe(200);

    const tenantId = nextTenantId();
    const body = jsonIngestBody(tenantId);
    const response = await request(handle.app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', `Bearer ${process.env.REWARD_TRACKING_INGEST_TOKEN}`)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'applied' });

    // TC-3 (this task's own): a bad token behaves identically to the standalone server's own guard
    // (401, not 404) — proving this is a real, registered, authenticated route, not a bypass.
    const badTokenResponse = await request(handle.app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', 'Bearer wrong-token')
      .send(jsonIngestBody(tenantId));
    expect(badTokenResponse.status).toBe(401);
  });

  // TC-5 + TC-6
  it('TC-5/TC-6: real reachable mock portal gRPC server — campaign_hierarchy_cache populates within one ListActiveCampaigns cycle, and the admin campaign-summary endpoint reflects it', async () => {
    const tenantId = nextTenantId();
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    const { server: mockPortal, port: mockPortalPort } = await startMockPortal({
      campaignsByTenant: new Map([[tenantId, [buildMockCampaign(tenantId, campaignCode)]]]),
    });

    process.env.PORTAL_GRPC_HOST = '127.0.0.1';
    process.env.PORTAL_GRPC_PORT = String(mockPortalPort);
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);

    try {
      handle = await bootstrap();

      // TC-5: campaign_hierarchy_cache populated within one ListActiveCampaigns cycle.
      await waitFor(async () => {
        const rows = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM reward_tracking.campaign_hierarchy_cache
             WHERE tenant_id = :tenantId AND campaign_code = :campaignCode AND is_active = true`,
          { type: QueryTypes.SELECT, replacements: { tenantId, campaignCode } },
        );
        return Number(rows[0].count) === 1;
      });

      // TC-6: GET /reward-tracking/campaigns/:code/summary reflects the real cached campaign
      // (a resolution failure — no cached row for this campaignCode/tenant — would 404 instead).
      const token = signPortalAdminToken(
        {
          role: 'super_admin',
          countryId: null,
          tenantId: null,
          merchantId: null,
          exp: Math.floor(Date.now() / 1000) + 300,
        },
        loadPortalAdminAuthSecret(),
      );

      const response = await request(handle.app.getHttpServer())
        .get(`/reward-tracking/campaigns/${campaignCode}/summary`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.campaignCode).toBe(campaignCode);
      expect(Array.isArray(response.body.totals)).toBe(true);
    } finally {
      // Close the app (and with it, `CampaignHierarchyClient`'s own still-open
      // `WatchCampaignConfig` stream against `mockPortal` below) BEFORE shutting the mock portal
      // down — `grpc.Server.tryShutdown()` waits for every active call to finish before its own
      // callback fires, so shutting the mock portal down first (while that stream is still open)
      // would hang until something else force-cancels it. `afterEach`'s own `handle.close()` call
      // becomes a no-op once `handle` is already `null` here.
      if (handle) {
        await handle.close();
        handle = null;
      }
      await stopMockPortal(mockPortal);
    }
  });

  // TC-7 (negative)
  it('TC-7 (negative): portal gRPC unreachable — CampaignCacheModule degrades gracefully (stale/empty cache), never crashes the app', async () => {
    const tenantId = nextTenantId();
    const unreachable = await unreachablePort();
    process.env.PORTAL_GRPC_HOST = '127.0.0.1';
    process.env.PORTAL_GRPC_PORT = String(unreachable);
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);

    handle = await bootstrap();

    const healthResponse = await request(handle.app.getHttpServer()).get('/health');
    expect(healthResponse.status).toBe(200);

    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.campaign_hierarchy_cache WHERE tenant_id = :tenantId',
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});
