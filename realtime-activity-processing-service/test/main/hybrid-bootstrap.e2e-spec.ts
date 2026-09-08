/**
 * T-INT-003. Real round trip through `startHybridBootstrap()` (`src/main.ts`) — the primary HTTP
 * app (`AppModule`) plus, independently, each of the three previously-standalone-only transports
 * this task wires in: the mTLS `ActivityIngestService` gRPC server, the `activity.ingest.v1` Kafka
 * consumer, and the customer progress REST API. Every scenario below calls `startHybridBootstrap()`
 * directly against real infrastructure (real local Postgres 16, real local Redpanda, a real
 * ephemeral mTLS CA) — the same "call the exported factory directly, in-process" precedent
 * `test/grpc/grpc-server.e2e-spec.ts` (T-RAP-022) and `test/e2e/progress-api.e2e-spec.ts`
 * (T-RAP-040) already set for this project, extended here to the one function that starts all four
 * listeners together. `AGENT-PROTOCOL.md` §3's "assert the observable property, not the
 * implementation string": every assertion below is either a real socket probe, a real gRPC client
 * round trip, a real Kafka publish + row landing, or a real HTTP request — never just "the function
 * we expect to have been called was called".
 *
 * Real-process-level verification (`npm run start:dev` + `curl`/`lsof`, and re-running
 * `ts-node ... grpc-server.main.ts` standalone) is this task's own completion report's job (task
 * file's own "Verification steps" table) — this file covers the task file's own TC-1 through TC-6
 * (TC-7, "the standalone file still works unmodified", is a no-code-change fact verified manually,
 * not something this file can meaningfully assert beyond what `grpc-server.e2e-spec.ts` already
 * proves by importing that exact same, untouched `createGrpcMicroservice` export).
 *
 * **Kafka consumer-group isolation**: this file's TC-3/TC-5 join the one real, shared
 * `ACTIVITY_INGEST_CONSUMER_GROUP` every instance of this service's Kafka ingress joins
 * (`ingest.config.ts`'s own header) — same real hazard `activity-ingest.consumer.e2e-spec.ts`'s own
 * header documents if a full, unfiltered `npm test` run schedules this file concurrently with that
 * one. This file holds `kafka-shared-consumer-group-lock.ts`'s own reader lease (not the exact-
 * membership-asserting writer role) for exactly the span it has a real consumer running, the same
 * "reader" precedent `test/e2e/full-pipeline-test-helpers.ts`'s own `startInstance()` already set.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { QueryTypes, type Sequelize } from 'sequelize';
import request from 'supertest';
import { startHybridBootstrap, HybridBootstrapError, type HybridBootstrapResult } from '@/main';
import { ACTIVITY_INGEST_TOPIC } from '@/messaging/ingest/ingest.config';
import {
  loadProgressApiAuthSecret,
  signProgressApiToken,
} from '@/modules/progress-api/progress-api-token';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { TestCertAuthority, type IssuedCertificate } from '../grpc/support/test-cert-authority';
import {
  createTestClient,
  callSubmitActivity,
  type ActivityIngestServiceTestClient,
} from '../grpc/support/test-grpc-client';
import {
  getFreePort,
  waitUntil,
  buildTestSequelize,
  READER_LEASE_ACQUIRE_TIMEOUT_MS,
} from '../e2e/full-pipeline-test-helpers';
import {
  acquireIngestConsumerGroupReaderLease,
  type IngestConsumerGroupReaderLease,
} from '../e2e/kafka-shared-consumer-group-lock';
import {
  seedCampaignConfigSnapshot,
  seedComponentProgress,
  cleanupTenant as cleanupProgressTenant,
} from '../e2e/progress-api-test-helpers';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-config.client';

jest.setTimeout(90_000);

const AES_KEY_B64 = Buffer.alloc(32, 21).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 22).toString('base64');
const PROGRESS_AUTH_SECRET_B64 = Buffer.alloc(32, 23).toString('base64');

let nextTenantId = 970_000 + Math.floor(Math.random() * 20_000);
function freshTenantId(): number {
  nextTenantId += 1;
  return nextTenantId;
}

/**
 * A test scenario that expects `startHybridBootstrap()` to SUCCEED must still never leak its
 * primary HTTP app if something unexpected throws instead (a `HybridBootstrapError` carries every
 * handle that DID start, including `httpApp`, specifically so a caller can clean up rather than
 * leaving a live listener/DB pool open for the rest of the Jest process's life — see `src/main.ts`'s
 * own header). Rethrows the original error either way so the test itself still fails normally.
 */
async function startExpectingSuccess(): Promise<HybridBootstrapResult> {
  try {
    return await startHybridBootstrap();
  } catch (error) {
    if (error instanceof HybridBootstrapError) {
      await error.partial.httpApp.close().catch(() => {});
    }
    throw error;
  }
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

/**
 * A `campaign_config_snapshot` row that genuinely matches `activityMessage()`'s `PURCHASE`
 * activity through to a real tracker component (`ActivityMapper.mapToComponents`) — the shallow
 * `seedCampaignConfigSnapshot` helper from `progress-api-test-helpers.ts` (trackers only, no
 * merchants/activities/components) is NOT enough for this: `ActivityIngestionService.ingest()`
 * returns early, without ever writing an `activity_logs` row, when zero tracker components match
 * (`activity-ingestion.service.ts`'s own "TC-5: zero active tracker components matched — a normal,
 * logged outcome, not an error" comment) — so any test that needs to observe a real row landing
 * (TC-2/TC-3/TC-5 below) needs an actual match, not just campaign existence. Same payload shape
 * `test/grpc/grpc-server.e2e-spec.ts`'s own `buildCampaignPayload()` already establishes.
 */
async function seedMatchingCampaignSnapshot(
  sequelize: Sequelize,
  tenantId: number,
  campaignCode: string,
): Promise<void> {
  const payload: CampaignConfigProto = {
    campaignId: tenantId,
    campaignCode,
    tenantId,
    countryId: 1,
    status: 'active',
    startDate: '2020-01-01T00:00:00.000Z',
    endDate: '2030-01-01T00:00:00.000Z',
    budget: { amount: '1000.0000', currency: 'USD' },
    maxParticipants: 1000,
    merchants: [
      {
        merchantId: 1,
        merchantCode: 'MERCH1',
        name: 'T-INT-003 e2e merchant',
        status: 'active',
        activities: [
          { activityId: 501, activityCode: 'PURCHASE', name: 'Purchase', externalCodes: [] },
        ],
      },
    ],
    trackers: [
      {
        trackerId: 701,
        trackerCode: 'TRK1',
        name: 'T-INT-003 e2e tracker',
        completionLogic: 'ALL',
        completionThreshold: 1,
        status: 'active',
        components: [
          {
            componentId: 801,
            componentCode: 'COMP1',
            name: 'T-INT-003 e2e component',
            activityId: 501,
            sequenceOrder: 1,
            isMandatory: true,
            status: 'active',
          },
        ],
      },
    ],
    rules: [],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS'],
    sectionsOmitted: [],
  };
  await sequelize.query(
    `INSERT INTO realtime_activity_processing.campaign_config_snapshot
       (tenant_id, campaign_code, config_version, is_active, payload, fetched_at, updated_at)
     VALUES (:tenantId, :campaignCode, 'hash-1', true, CAST(:payload AS jsonb), now(), now())`,
    {
      type: QueryTypes.RAW,
      replacements: { tenantId, campaignCode, payload: JSON.stringify(payload) },
    },
  );
}

function activityMessage(
  tenantId: number,
  customerId: string,
  activityEventId: string,
): Record<string, unknown> {
  return {
    tenantId,
    customerId,
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: '2026-09-01T10:15:30Z',
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'USD',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    activityEventId,
  };
}

/**
 * Baseline env every scenario starts from: valid field-encryption key material (required the
 * instant any module touching `EncryptionService` is constructed, even for HTTP-only TC-1), and
 * the outbound portal gRPC client deliberately pointed at an unused local port so
 * `CampaignConfigCacheService.bootstrap()` fails fast rather than hanging or racing a real portal
 * process — same precedent `test/grpc/grpc-server.e2e-spec.ts`'s own header documents. Every one
 * of the three T-INT-003 hybrid gates is unset (= disabled) here; each test flips on only the ones
 * it exercises. `PORT` is pinned to a freshly allocated free port so this suite never collides with
 * a real locally-running dev instance on 3020.
 */
async function resetEnvToBaseline(tenantId: number): Promise<void> {
  delete process.env.GRPC_SERVER_ENABLED;
  delete process.env.ACTIVITY_INGEST_CONSUMER_ENABLED;
  delete process.env.PROGRESS_API_ENABLED;
  delete process.env.GRPC_SERVER_PORT;
  delete process.env.GRPC_SERVER_TLS_CA_PATH;
  delete process.env.GRPC_SERVER_TLS_CERT_PATH;
  delete process.env.GRPC_SERVER_TLS_KEY_PATH;
  delete process.env.GRPC_SERVER_ALLOWED_IDENTITIES;
  delete process.env.PROGRESS_API_PORT;
  delete process.env.PROGRESS_API_AUTH_SECRET;

  process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
  process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;

  process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);
  process.env.PORTAL_GRPC_HOST = '127.0.0.1';
  process.env.PORTAL_GRPC_PORT = String(await getFreePort());
  process.env.PORTAL_GRPC_TIMEOUT_MS = '1000';
  delete process.env.PORTAL_GRPC_TLS_CA_PATH;
  delete process.env.PORTAL_GRPC_TLS_CERT_PATH;
  delete process.env.PORTAL_GRPC_TLS_KEY_PATH;

  process.env.PORT = String(await getFreePort());
}

describe('T-INT-003 — hybrid bootstrap (src/main.ts) (e2e, real Postgres, real Redpanda, real mTLS)', () => {
  // TC-1
  it('TC-1: with all three gates unset, only the primary HTTP listener opens', async () => {
    await resetEnvToBaseline(freshTenantId());

    const result = await startExpectingSuccess();
    try {
      expect(result.grpcApp).toBeNull();
      expect(result.ingestConsumerContext).toBeNull();
      expect(result.progressApiApp).toBeNull();

      const health = await request(result.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);

      // Confirm absence at the socket level too, not just "the handle is null" — the default
      // ports for both other transports must genuinely be unbound.
      await expect(isPortOpen(50071)).resolves.toBe(false);
      await expect(isPortOpen(3021)).resolves.toBe(false);
    } finally {
      await result.httpApp.close();
    }
  });

  // TC-2
  it('TC-2: GRPC_SERVER_ENABLED=true starts a real, working mTLS gRPC listener', async () => {
    const tenantId = freshTenantId();
    await resetEnvToBaseline(tenantId);

    const ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    const identity = `rap-int003-tc2-${tenantId}`;
    process.env.GRPC_SERVER_ENABLED = 'true';
    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${identity}:${tenantId}`;

    // `CampaignConfigCacheService.bootstrap()` refuses a cold start with neither a local
    // `campaign_config_snapshot` row nor a reachable portal (by design — see that service's own
    // header) — this test deliberately points the portal client at an unused port (baseline), so
    // at least one local snapshot row must exist for this tenant, same precedent
    // `grpc-server.e2e-spec.ts`'s own `beforeAll` seeding already set.
    const seedSequelize = buildTestSequelize();
    await seedMatchingCampaignSnapshot(seedSequelize, tenantId, `CAMP-INT003-TC2-${tenantId}`);

    const result = await startExpectingSuccess();
    let client: ActivityIngestServiceTestClient | undefined;
    try {
      expect(result.grpcApp).not.toBeNull();
      expect(result.ingestConsumerContext).toBeNull();
      expect(result.progressApiApp).toBeNull();

      const clientCert: IssuedCertificate = ca.issueClientCert(identity);
      const credentials = grpc.credentials.createSsl(
        readFileSync(ca.caCertPath),
        readFileSync(clientCert.keyPath),
        readFileSync(clientCert.certPath),
      );
      client = createTestClient(`127.0.0.1:${grpcPort}`, credentials);

      const response = await callSubmitActivity(client, {
        customerId: `cust-${randomUUID()}`,
        customerIdType: 'INTERNAL_ID',
        activityPerformedDate: '2026-09-01T10:15:30Z',
        activityCode: 'PURCHASE',
        activityType: 'TRANSACTION',
        activityCategory: 'RETAIL',
        activityValue: '100.0000',
        activityValueUnit: 'USD',
        channel: 'WEB',
        activityPerformedEnv: 'PROD',
        activityName: 'Online purchase',
        activityEventId: `evt-${randomUUID()}`,
      });

      // A REAL response from a REAL listening server through this task's own hybrid bootstrap,
      // not a mocked transport — `seedMatchingCampaignSnapshot` above guarantees a genuine match
      // so this also proves the full ingest pipeline (mapping, not just transport wiring) ran.
      expect(response.status).toBe('accepted');
      expect(response.matchedTrackerComponents).toEqual(['COMP1']);
      expect(response.correlationId.length).toBeGreaterThan(0);
    } finally {
      client?.close();
      await result.grpcApp?.close();
      await result.httpApp.close();
      ca.cleanup();
      await cleanupProgressTenant(seedSequelize, tenantId);
      await seedSequelize.close();
    }
  });

  // TC-3
  it('TC-3: ACTIVITY_INGEST_CONSUMER_ENABLED=true consumes a real message from activity.ingest.v1', async () => {
    const tenantId = freshTenantId();
    await resetEnvToBaseline(tenantId);
    process.env.ACTIVITY_INGEST_CONSUMER_ENABLED = 'true';

    // Same cold-start requirement TC-2 documents: IngestModule also pulls in
    // ActivityMappingModule -> CampaignConfigCacheModule, which refuses to boot with neither a
    // local snapshot row nor a reachable portal for this tenant.
    const seedSequelize = buildTestSequelize();
    await seedMatchingCampaignSnapshot(seedSequelize, tenantId, `CAMP-INT003-TC3-${tenantId}`);

    const lease: IngestConsumerGroupReaderLease = await acquireIngestConsumerGroupReaderLease(
      READER_LEASE_ACQUIRE_TIMEOUT_MS,
    );
    let sequelize: Sequelize | undefined;
    let producer: Producer | undefined;
    try {
      const result = await startExpectingSuccess();
      try {
        expect(result.ingestConsumerContext).not.toBeNull();
        expect(result.grpcApp).toBeNull();
        expect(result.progressApiApp).toBeNull();

        const kafka = new Kafka({
          clientId: 'rap-int003-tc3-producer',
          brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9093').split(','),
          logLevel: logLevel.NOTHING,
        });
        producer = kafka.producer();
        await producer.connect();

        const activityEventId = `int003-tc3-${randomUUID()}`;
        const customerId = `cust-int003-tc3-${randomUUID()}`;
        await producer.send({
          topic: ACTIVITY_INGEST_TOPIC,
          messages: [
            {
              key: customerId,
              value: JSON.stringify(activityMessage(tenantId, customerId, activityEventId)),
            },
          ],
        });

        sequelize = buildTestSequelize();
        await waitUntil(async () => {
          const rows = await sequelize!.query(
            `SELECT source_transport FROM realtime_activity_processing.activity_logs
              WHERE tenant_id = :tenantId AND dedup_key = :dedupKey`,
            { type: QueryTypes.SELECT, replacements: { tenantId, dedupKey: activityEventId } },
          );
          return rows.length === 1;
        }, 30_000);

        const rows = await sequelize.query<{ source_transport: string }>(
          `SELECT source_transport FROM realtime_activity_processing.activity_logs
            WHERE tenant_id = :tenantId AND dedup_key = :dedupKey`,
          { type: QueryTypes.SELECT, replacements: { tenantId, dedupKey: activityEventId } },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].source_transport).toBe('KAFKA');
      } finally {
        await result.ingestConsumerContext?.close();
        await result.httpApp.close();
      }
    } finally {
      if (sequelize) {
        await sequelize.query(
          'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
          { type: QueryTypes.RAW, replacements: { tenantId } },
        );
        await sequelize.close();
      }
      await producer?.disconnect();
      lease.release();
      await cleanupProgressTenant(seedSequelize, tenantId);
      await seedSequelize.close();
    }
  }, 120_000);

  // TC-4
  it('TC-4: PROGRESS_API_ENABLED=true starts a real, auth-guarded progress API', async () => {
    const tenantId = freshTenantId();
    await resetEnvToBaseline(tenantId);

    const progressApiPort = await getFreePort();
    process.env.PROGRESS_API_ENABLED = 'true';
    process.env.PROGRESS_API_PORT = String(progressApiPort);
    process.env.PROGRESS_API_AUTH_SECRET = PROGRESS_AUTH_SECRET_B64;

    const customerId = `cust-int003-tc4-${randomUUID()}`;
    const campaignCode = `CAMP-INT003-TC4-${tenantId}`;
    const trackerCode = 'TRK1';

    const seedSequelize = buildTestSequelize();
    const encryption = new EncryptionService(loadEncryptionKeyMaterial());
    const customerIdHash = encryption.hash(customerId);
    await seedCampaignConfigSnapshot(seedSequelize, tenantId, campaignCode, [
      { trackerCode, completionLogic: 'all' },
    ]);
    await seedComponentProgress(seedSequelize, {
      tenantId,
      customerIdHash,
      campaignCode,
      trackerCode,
      trackerComponentCode: 'COMP1',
      currentCount: 1,
      requiredCount: 2,
    });

    const result = await startExpectingSuccess();
    try {
      expect(result.progressApiApp).not.toBeNull();
      expect(result.grpcApp).toBeNull();
      expect(result.ingestConsumerContext).toBeNull();

      const server = result.progressApiApp!.getHttpServer();

      const unauthenticated = await request(server).get(
        `/progress/customers/${customerId}/campaigns/${campaignCode}`,
      );
      expect(unauthenticated.status).toBe(401);

      const token = signProgressApiToken(
        { tenantId, customerId, exp: Math.floor(Date.now() / 1000) + 3600 },
        loadProgressApiAuthSecret(),
      );
      const authenticated = await request(server)
        .get(`/progress/customers/${customerId}/campaigns/${campaignCode}`)
        .set('Authorization', `Bearer ${token}`);
      expect(authenticated.status).toBe(200);
    } finally {
      await result.progressApiApp?.close();
      await result.httpApp.close();
      await cleanupProgressTenant(seedSequelize, tenantId);
      await seedSequelize.close();
    }
  });

  // TC-5
  it('TC-5: all three transports enabled simultaneously come up in one process with no collision', async () => {
    const tenantId = freshTenantId();
    await resetEnvToBaseline(tenantId);

    const ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    const identity = `rap-int003-tc5-${tenantId}`;
    process.env.GRPC_SERVER_ENABLED = 'true';
    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${identity}:${tenantId}`;

    process.env.ACTIVITY_INGEST_CONSUMER_ENABLED = 'true';

    const progressApiPort = await getFreePort();
    process.env.PROGRESS_API_ENABLED = 'true';
    process.env.PROGRESS_API_PORT = String(progressApiPort);
    process.env.PROGRESS_API_AUTH_SECRET = PROGRESS_AUTH_SECRET_B64;

    // See TC-2's own comment: at least one local campaign_config_snapshot row must exist for this
    // tenant, since the portal client is deliberately unreachable (baseline).
    const seedSequelize = buildTestSequelize();
    await seedMatchingCampaignSnapshot(seedSequelize, tenantId, `CAMP-INT003-TC5-${tenantId}`);

    const lease: IngestConsumerGroupReaderLease = await acquireIngestConsumerGroupReaderLease(
      READER_LEASE_ACQUIRE_TIMEOUT_MS,
    );
    let sequelize: Sequelize | undefined;
    let producer: Producer | undefined;
    let client: ActivityIngestServiceTestClient | undefined;
    try {
      const result = await startExpectingSuccess();
      try {
        expect(result.grpcApp).not.toBeNull();
        expect(result.ingestConsumerContext).not.toBeNull();
        expect(result.progressApiApp).not.toBeNull();

        // HTTP surface.
        const health = await request(result.httpApp.getHttpServer()).get('/health');
        expect(health.status).toBe(200);

        // gRPC surface.
        const clientCert: IssuedCertificate = ca.issueClientCert(identity);
        const credentials = grpc.credentials.createSsl(
          readFileSync(ca.caCertPath),
          readFileSync(clientCert.keyPath),
          readFileSync(clientCert.certPath),
        );
        client = createTestClient(`127.0.0.1:${grpcPort}`, credentials);
        const grpcResponse = await callSubmitActivity(client, {
          customerId: `cust-${randomUUID()}`,
          customerIdType: 'INTERNAL_ID',
          activityPerformedDate: '2026-09-01T10:15:30Z',
          activityCode: 'PURCHASE',
          activityType: 'TRANSACTION',
          activityCategory: 'RETAIL',
          activityValue: '100.0000',
          activityValueUnit: 'USD',
          channel: 'WEB',
          activityPerformedEnv: 'PROD',
          activityName: 'Online purchase',
          activityEventId: `evt-int003-tc5-${randomUUID()}`,
        });
        expect(grpcResponse.status).toBe('accepted');

        // Progress API surface (auth-guard only — no seeded data needed to prove it's live).
        const progressResponse = await request(result.progressApiApp!.getHttpServer()).get(
          `/progress/customers/cust-tc5/campaigns/CAMP-TC5`,
        );
        expect(progressResponse.status).toBe(401);

        // Kafka surface.
        const kafka = new Kafka({
          clientId: 'rap-int003-tc5-producer',
          brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9093').split(','),
          logLevel: logLevel.NOTHING,
        });
        producer = kafka.producer();
        await producer.connect();
        const activityEventId = `int003-tc5-${randomUUID()}`;
        const customerId = `cust-int003-tc5-kafka-${randomUUID()}`;
        await producer.send({
          topic: ACTIVITY_INGEST_TOPIC,
          messages: [
            {
              key: customerId,
              value: JSON.stringify(activityMessage(tenantId, customerId, activityEventId)),
            },
          ],
        });

        sequelize = buildTestSequelize();
        await waitUntil(async () => {
          const rows = await sequelize!.query(
            `SELECT 1 FROM realtime_activity_processing.activity_logs
              WHERE tenant_id = :tenantId AND dedup_key = :dedupKey`,
            { type: QueryTypes.SELECT, replacements: { tenantId, dedupKey: activityEventId } },
          );
          return rows.length === 1;
        }, 30_000);
      } finally {
        client?.close();
        await result.grpcApp?.close();
        await result.ingestConsumerContext?.close();
        await result.progressApiApp?.close();
        await result.httpApp.close();
      }
    } finally {
      if (sequelize) {
        await sequelize.query(
          'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
          { type: QueryTypes.RAW, replacements: { tenantId } },
        );
        await sequelize.close();
      }
      await producer?.disconnect();
      lease.release();
      ca.cleanup();
      await cleanupProgressTenant(seedSequelize, tenantId);
      await seedSequelize.close();
    }
  }, 120_000);

  // TC-6 (negative)
  it('TC-6: GRPC_SERVER_ENABLED=true with required TLS config missing rejects, without silently downgrading', async () => {
    const tenantId = freshTenantId();
    await resetEnvToBaseline(tenantId);
    process.env.GRPC_SERVER_ENABLED = 'true';
    // Deliberately leave GRPC_SERVER_TLS_CA_PATH/CERT_PATH/KEY_PATH and
    // GRPC_SERVER_ALLOWED_IDENTITIES unset — the required-config-missing case.

    let caught: HybridBootstrapError | undefined;
    try {
      await startHybridBootstrap();
      throw new Error('expected startHybridBootstrap() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(HybridBootstrapError);
      caught = error as HybridBootstrapError;
    }

    try {
      expect(caught!.failures).toHaveLength(1);
      expect(caught!.failures[0].label).toContain('gRPC');
      expect(caught!.partial.grpcApp).toBeNull();
      expect(caught!.partial.ingestConsumerContext).toBeNull();
      expect(caught!.partial.progressApiApp).toBeNull();

      // The primary HTTP app must still be a real, live, working app — a misconfigured OPTIONAL
      // transport must never take the primary listener down with it (implementation note 4).
      expect(caught!.partial.httpApp).toBeDefined();
      const health = await request(caught!.partial.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await caught?.partial.httpApp.close();
    }
  });
});
