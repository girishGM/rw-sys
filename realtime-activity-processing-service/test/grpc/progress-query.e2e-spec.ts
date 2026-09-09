/**
 * T-INT-020 — real round trip: a real `@grpc/proto-loader`-built client, over real mTLS (same
 * ephemeral CA/server/client certificate machinery `test-cert-authority.ts` already provides for
 * `ActivityIngestService`'s own e2e suite), against a real, listening `GrpcMicroserviceRootModule`
 * (`src/grpc/grpc-server.main.ts`) backed by the real, already-migrated
 * `realtime_activity_processing` schema on the real local Postgres 16 server (root `CLAUDE.md`) —
 * same "assert the observable property, not the implementation string" discipline
 * `AGENT-PROTOCOL.md` §3 requires: only a real client dialing a real, listening
 * `ProgressQueryService` can actually prove the wire contract (method path, message shape, status
 * codes), not a mocked transport.
 *
 * Seed data is written directly to the tables `ProgressRepository` reads
 * (`customer_tracker_component_progress`/`customer_tracker_status`/`campaign_config_snapshot`), via
 * the same `test/e2e/progress-api-test-helpers.ts` this project's own REST e2e suite
 * (`test/e2e/progress-api.e2e-spec.ts`) already uses — this module is entirely read-only in
 * production, so driving the Wave 3 write pipeline is out of scope for this test too (T-RAP-040's
 * own Scope "Out", still true here).
 *
 * A client certificate is still required to complete the TLS handshake on this shared mTLS port
 * (`grpc-server.bootstrap.ts`'s `ServerCredentials.createSsl(..., checkClientCertificate: true)`
 * applies to every RPC on this server, not just `ActivityIngestService`'s own) — but unlike
 * `ActivityIngestService`, `ProgressQueryController` has no `@UseGuards(MtlsGuard)`, so the
 * client's identity does **not** need to be on `GRPC_SERVER_ALLOWED_IDENTITIES`: any certificate
 * signed by the same CA completes the handshake, and the bearer token
 * (`progress-query.controller.ts`'s own `authenticate()`) is the real authorization boundary for
 * this service. This is a genuine, intentional split of the two controllers' trust models sharing
 * one physical connection — see `progress-query.controller.ts`'s own header for the full reasoning,
 * flagged again here since it shapes how this test's own client is built (no allowlist env
 * configuration needed for the identity this test's client cert carries).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestMicroservice } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { Sequelize } from 'sequelize-typescript';
import { createGrpcMicroservice } from '@/grpc/grpc-server.main';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import {
  loadProgressApiAuthSecret,
  signProgressApiToken,
} from '@/modules/progress-api/progress-api-token';
import { TestCertAuthority, type IssuedCertificate } from './support/test-cert-authority';
import {
  createTestClient,
  callSubmitActivity,
  type ActivityIngestServiceTestClient,
} from './support/test-grpc-client';
import {
  buildTestSequelize,
  cleanupTenant,
  seedCampaignConfigSnapshot,
  seedComponentProgress,
  seedTrackerStatus,
} from '../e2e/progress-api-test-helpers';
import type {
  CampaignProgressResponseProto,
  GetCampaignProgressRequestProto,
  GetTrackerProgressRequestProto,
  TrackerProgressResponseProto,
} from '@/grpc/progress-query.grpc.types';

jest.setTimeout(30000);

const AES_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const AUTH_SECRET_B64 = Buffer.alloc(32, 11).toString('base64');

/** Deliberately never added to `GRPC_SERVER_ALLOWED_IDENTITIES` — this suite's own proof that
 * `ProgressQueryService` calls succeed on identity alone completing the TLS handshake, with no
 * `MtlsGuard`/allowlist check of their own (see this file's own header). */
const PROGRESS_QUERY_CLIENT_IDENTITY = 'rap-e2e-progress-query-client';
/** Added to the allowlist below purely so TC-6 can prove `ActivityIngestService` itself is
 * unaffected by this task's change — a concern for `MtlsGuard`, not `ProgressQueryController`. */
const ACTIVITY_INGEST_CLIENT_IDENTITY = 'rap-e2e-progress-query-tc6-activity-ingest-client';
const TENANT_ID = 940_000 + Math.floor(Math.random() * 30_000);

interface ProgressQueryServiceTestClient extends grpc.Client {
  GetCampaignProgress(
    request: GetCampaignProgressRequestProto,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response?: CampaignProgressResponseProto) => void,
  ): grpc.ClientUnaryCall;
  GetTrackerProgress(
    request: GetTrackerProgressRequestProto,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response?: TrackerProgressResponseProto) => void,
  ): grpc.ClientUnaryCall;
}

interface LoadedProgressQueryPackage {
  rewardrap: {
    progress: {
      v1: {
        ProgressQueryService: new (
          address: string,
          credentials: grpc.ChannelCredentials,
        ) => ProgressQueryServiceTestClient;
      };
    };
  };
}

function resolveProgressQueryProtoPath(): string {
  // Mirrors `grpc-server.bootstrap.ts`'s own (unexported) `resolveProgressQueryProtoPath()` — this
  // file is a test, not production code granted access to that internal helper, so it recomputes
  // the same path independently (same "load the proto the same way the server itself does"
  // precedent `test-grpc-client.ts`'s own header sets for `activity_ingest.proto`).
  return join(__dirname, '..', '..', 'proto', 'progress_query.v1.proto');
}

function createProgressQueryClient(
  address: string,
  credentials: grpc.ChannelCredentials,
): ProgressQueryServiceTestClient {
  const packageDefinition = protoLoader.loadSync(resolveProgressQueryProtoPath(), {});
  const loaded = grpc.loadPackageDefinition(
    packageDefinition,
  ) as unknown as LoadedProgressQueryPackage;
  return new loaded.rewardrap.progress.v1.ProgressQueryService(address, credentials);
}

function callGetCampaignProgress(
  client: ProgressQueryServiceTestClient,
  request: GetCampaignProgressRequestProto,
  token?: string,
): Promise<CampaignProgressResponseProto> {
  const metadata = new grpc.Metadata();
  if (token !== undefined) {
    metadata.set('authorization', `Bearer ${token}`);
  }
  return new Promise((resolve, reject) => {
    client.GetCampaignProgress(request, metadata, (error, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(response as CampaignProgressResponseProto);
      }
    });
  });
}

function callGetTrackerProgress(
  client: ProgressQueryServiceTestClient,
  request: GetTrackerProgressRequestProto,
  token?: string,
): Promise<TrackerProgressResponseProto> {
  const metadata = new grpc.Metadata();
  if (token !== undefined) {
    metadata.set('authorization', `Bearer ${token}`);
  }
  return new Promise((resolve, reject) => {
    client.GetTrackerProgress(request, metadata, (error, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(response as TrackerProgressResponseProto);
      }
    });
  });
}

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

describe('T-INT-020 — ProgressQueryService gRPC (real mTLS, real Postgres) (e2e)', () => {
  let ca: TestCertAuthority;
  let microserviceApp: INestMicroservice;
  let sequelize: Sequelize;
  let encryption: EncryptionService;
  let address: string;
  let progressQueryClientCert: IssuedCertificate;
  let activityIngestClientCert: IssuedCertificate;

  beforeAll(async () => {
    ca = TestCertAuthority.build();
    const [grpcPort, unusedPortalPort] = await Promise.all([getFreePort(), getFreePort()]);
    address = `localhost:${grpcPort}`;

    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    // `PROGRESS_QUERY_CLIENT_IDENTITY` deliberately absent — see this file's own header.
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${ACTIVITY_INGEST_CLIENT_IDENTITY}:${TENANT_ID}`;
    delete process.env.GRPC_SERVER_ENABLED;

    // Deliberately unreachable — `CampaignConfigCacheService.bootstrap()` (triggered by this app's
    // own module init) should fail fast rather than race a real portal process. Same precedent
    // `grpc-server.e2e-spec.ts`'s own header documents for the sibling suite.
    process.env.PORTAL_GRPC_HOST = 'localhost';
    process.env.PORTAL_GRPC_PORT = String(unusedPortalPort);
    process.env.PORTAL_GRPC_TIMEOUT_MS = '1000';
    delete process.env.PORTAL_GRPC_TLS_CA_PATH;
    delete process.env.PORTAL_GRPC_TLS_CERT_PATH;
    delete process.env.PORTAL_GRPC_TLS_KEY_PATH;
    process.env.PORTAL_CONFIG_TENANT_IDS = String(TENANT_ID);

    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
    process.env.PROGRESS_API_AUTH_SECRET = AUTH_SECRET_B64;

    sequelize = buildTestSequelize();
    await sequelize.authenticate();
    encryption = new EncryptionService(loadEncryptionKeyMaterial());

    // `CampaignConfigCacheService.onModuleInit()` (triggered by `createGrpcMicroservice()` below,
    // via the same `GrpcMicroserviceRootModule` `ActivityIngestService` already boots through)
    // fails cold start loudly unless at least one local `campaign_config_snapshot` row already
    // exists for this suite's own tenant — same precedent `grpc-server.e2e-spec.ts`'s own `beforeAll`
    // already set (there, by seeding the one campaign its own tests match against; here, a
    // dedicated bootstrap-only row, since each test below seeds its own campaign separately).
    await seedCampaignConfigSnapshot(sequelize, TENANT_ID, `CAMP-BOOTSTRAP-${TENANT_ID}`, [
      { trackerCode: 'TRK-BOOTSTRAP', completionLogic: 'all' },
    ]);

    const app = await createGrpcMicroservice();
    if (app === null) {
      throw new Error('expected createGrpcMicroservice() to return a microservice in this test');
    }
    microserviceApp = app;
    await microserviceApp.listen();

    progressQueryClientCert = ca.issueClientCert(PROGRESS_QUERY_CLIENT_IDENTITY);
    activityIngestClientCert = ca.issueClientCert(ACTIVITY_INGEST_CLIENT_IDENTITY);
  });

  afterAll(async () => {
    await cleanupTenant(sequelize, TENANT_ID);
    await sequelize.close();
    await microserviceApp.close();
    ca.cleanup();
  });

  function progressClient(): ProgressQueryServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(progressQueryClientCert.keyPath),
      readFileSync(progressQueryClientCert.certPath),
    );
    return createProgressQueryClient(address, credentials);
  }

  function activityIngestClient(): ActivityIngestServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(activityIngestClientCert.keyPath),
      readFileSync(activityIngestClientCert.certPath),
    );
    return createTestClient(address, credentials);
  }

  function tokenFor(customerId: string, expiresInSeconds = 3600): string {
    return signProgressApiToken(
      { tenantId: TENANT_ID, customerId, exp: Math.floor(Date.now() / 1000) + expiresInSeconds },
      loadProgressApiAuthSecret(),
    );
  }

  // TC-1
  it('TC-1: GetCampaignProgress matches the REST equivalent field-for-field for a real, seeded customer/campaign', async () => {
    const customerId = `cust-${randomUUID()}`;
    const customerIdHash = encryption.hash(customerId);
    const campaignCode = `CAMP-TC1-${TENANT_ID}`;

    await seedCampaignConfigSnapshot(sequelize, TENANT_ID, campaignCode, [
      { trackerCode: 'TRK1', completionLogic: 'all' },
    ]);
    await seedComponentProgress(sequelize, {
      tenantId: TENANT_ID,
      customerIdHash,
      campaignCode,
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      currentCount: 1,
      requiredCount: 3,
    });

    const client = progressClient();
    const response = await callGetCampaignProgress(
      client,
      { customerId, campaignCode },
      tokenFor(customerId),
    );

    // Field-for-field parity with `ProgressService.getCampaignProgress`'s own REST-equivalent
    // shape (`progress.types.ts`) — the same domain provider, so this is a genuine parity
    // assertion, not a restated constant.
    expect(response.customerId).toBe(customerId);
    expect(response.campaignCode).toBe(campaignCode);
    const trackers = response.trackers ?? [];
    expect(trackers).toHaveLength(1);
    const [tracker] = trackers;
    expect(tracker).toMatchObject({
      trackerCode: 'TRK1',
      completionLogic: 'all',
      isCompleted: false,
      completedAt: '',
      componentsRequiredCount: 1,
      componentsCompletedCount: 0,
    });
    expect(tracker.components).toEqual([
      { componentCode: 'COMP1', currentCount: 1, requiredCount: 3, isCompleted: false },
    ]);
    client.close();
  });

  // TC-2
  it('TC-2: GetTrackerProgress matches the REST equivalent unwrapped single-tracker shape', async () => {
    const customerId = `cust-${randomUUID()}`;
    const customerIdHash = encryption.hash(customerId);
    const campaignCode = `CAMP-TC2-${TENANT_ID}`;

    await seedCampaignConfigSnapshot(sequelize, TENANT_ID, campaignCode, [
      { trackerCode: 'TRK2', completionLogic: 'any' },
    ]);
    await seedComponentProgress(sequelize, {
      tenantId: TENANT_ID,
      customerIdHash,
      campaignCode,
      trackerCode: 'TRK2',
      trackerComponentCode: 'COMP2',
      currentCount: 1,
      requiredCount: 1,
      isCompleted: true,
    });
    await seedTrackerStatus(sequelize, {
      tenantId: TENANT_ID,
      customerIdHash,
      campaignCode,
      trackerCode: 'TRK2',
      componentsRequiredCount: 1,
      componentsCompletedCount: 1,
      isCompleted: true,
    });

    const client = progressClient();
    const response = await callGetTrackerProgress(
      client,
      { customerId, campaignCode, trackerCode: 'TRK2' },
      tokenFor(customerId),
    );

    expect(response.customerId).toBe(customerId);
    expect(response.campaignCode).toBe(campaignCode);
    expect(response.trackerCode).toBe('TRK2');
    expect(response.isCompleted).toBe(true);
    expect(response.completedAt.length).toBeGreaterThan(0);
    expect(response.components).toEqual([
      { componentCode: 'COMP2', currentCount: 1, requiredCount: 1, isCompleted: true },
    ]);
    client.close();
  });

  // TC-3
  it('TC-3: no bearer token in gRPC metadata is UNAUTHENTICATED', async () => {
    const client = progressClient();

    await expect(
      callGetCampaignProgress(client, { customerId: 'cust-tc3', campaignCode: 'CAMP_TC3' }),
    ).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    client.close();
  });

  it('TC-3 (continued): an invalid/garbage bearer token is UNAUTHENTICATED', async () => {
    const client = progressClient();

    await expect(
      callGetCampaignProgress(
        client,
        { customerId: 'cust-tc3b', campaignCode: 'CAMP_TC3' },
        'not-a-real-token',
      ),
    ).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    client.close();
  });

  // TC-4
  it('TC-4: a valid token for a different customerId than requested is PERMISSION_DENIED', async () => {
    const client = progressClient();

    await expect(
      callGetCampaignProgress(
        client,
        { customerId: 'cust-tc4-victim', campaignCode: 'CAMP_TC4' },
        tokenFor('cust-tc4-someone-else'),
      ),
    ).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    client.close();
  });

  // TC-5
  it('TC-5: a customer/campaign with no materialized progress at all returns empty trackers, not an error', async () => {
    const customerId = `cust-${randomUUID()}`;
    const client = progressClient();

    const campaignResponse = await callGetCampaignProgress(
      client,
      { customerId, campaignCode: 'CAMP_NEVER_TOUCHED' },
      tokenFor(customerId),
    );
    // proto3 `repeated` with zero entries deserializes to `undefined` on this client's own loader
    // options (no `defaults: true`) — same convention `grpc-server.e2e-spec.ts`'s own TC-2 already
    // documents for `matched_tracker_components`.
    expect(campaignResponse.trackers ?? []).toEqual([]);
    expect(campaignResponse.customerId).toBe(customerId);
    expect(campaignResponse.campaignCode).toBe('CAMP_NEVER_TOUCHED');

    const trackerResponse = await callGetTrackerProgress(
      client,
      { customerId, campaignCode: 'CAMP_NEVER_TOUCHED', trackerCode: 'TRK_NEVER_TOUCHED' },
      tokenFor(customerId),
    );
    expect(trackerResponse.isCompleted).toBe(false);
    expect(trackerResponse.completionLogic).toBe('');
    expect(trackerResponse.completedAt).toBe('');
    expect(trackerResponse.componentsRequiredCount).toBe(0);
    expect(trackerResponse.componentsCompletedCount).toBe(0);
    expect(trackerResponse.components ?? []).toEqual([]);
    client.close();
  });

  // TC-6
  it('TC-6: ActivityIngestService.SubmitActivity is still reachable, unaffected, on the same gRPC server', async () => {
    const client = activityIngestClient();

    const response = await callSubmitActivity(client, {
      customerId: `cust-${randomUUID()}`,
      customerIdType: 'INTERNAL_ID',
      activityPerformedDate: '2026-09-01T10:15:30Z',
      activityCode: 'PURCHASE-TC6-NO-MATCH',
      activityType: 'TRANSACTION',
      activityCategory: 'RETAIL',
      activityValue: '10.0000',
      activityValueUnit: 'USD',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 'T-INT-020 TC-6 coexistence check',
      activityEventId: `evt-${randomUUID()}`,
    });

    expect(response.status).toBe('accepted');
    client.close();
  });
});
