/**
 * T-INT-054. Real round trip: real HTTP (supertest) against `ActivityIngestRestModule` — the exact
 * module `app.module.ts` registers into `AppModule` once an operator sets
 * `ACTIVITY_INGEST_REST_ENABLED=true` — backed by the real, already-migrated
 * `realtime_activity_processing` schema on the real local Postgres 16 server (root `CLAUDE.md`),
 * same "assert the observable property, not the implementation string" discipline
 * `reward-entries.e2e-spec.ts` (T-RR-013) and this project's own `grpc-server.e2e-spec.ts`
 * (T-RAP-022) already established for their own sibling ingestion endpoints.
 *
 * **Built directly from `ActivityIngestRestModule`, not from `AppModule` + the env-gate**, same
 * "test the composition root the transport actually needs, not the gate around it" precedent
 * `grpc-server.e2e-spec.ts` already sets (it calls `createGrpcMicroservice()` directly rather than
 * `startHybridBootstrap()` with `GRPC_SERVER_ENABLED=true`). `app.module.ts`'s own conditional
 * `...(activityIngestRestEnabled ? [ActivityIngestRestModule] : [])` is a one-line, low-risk
 * inclusion already exercised structurally by every other e2e suite that boots the real `AppModule`
 * with the flag left at its own default (`false`) and observes no change — see that file's own
 * header for why a real attempt to flip this flag process-wide for a dedicated Jest run was tried
 * and reverted (it broke `test/main/hybrid-bootstrap.e2e-spec.ts`'s own TC-1).
 *
 * No portal gRPC server is running in this environment — same deliberate "point PORTAL_GRPC_PORT
 * at a free, unreachable port" setup `grpc-server.e2e-spec.ts`'s own header documents, so
 * `CampaignConfigCacheService.bootstrap()` rebuilds its in-memory index from the directly-seeded
 * `campaign_config_snapshot` row below rather than racing a real portal.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Sequelize, QueryTypes } from 'sequelize';
import { ConfigModule } from '@/config/config.module';
import { ActivityIngestRestModule } from '@/rest/activity-ingest/activity-ingest-rest.module';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-config.client';

jest.setTimeout(30000);

const TENANT_ID = 940_000 + Math.floor(Math.random() * 9_999);
const CAMPAIGN_CODE = `CAMP-T-INT-054-${TENANT_ID}`;
const TOKEN = 'a-real-activity-ingest-rest-token-for-e2e';

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

function buildCampaignPayload(): CampaignConfigProto {
  return {
    campaignId: TENANT_ID,
    campaignCode: CAMPAIGN_CODE,
    tenantId: TENANT_ID,
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
        name: 'T-INT-054 e2e merchant',
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
        name: 'T-INT-054 e2e tracker',
        completionLogic: 'ALL',
        completionThreshold: 1,
        status: 'active',
        components: [
          {
            componentId: 801,
            componentCode: 'COMP1',
            name: 'T-INT-054 e2e component',
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
}

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    customerId: `cust-${randomUUID()}`,
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: '2026-09-01T10:15:30Z',
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'GENERAL',
    activityValue: '12.5',
    activityValueUnit: 'USD',
    channel: 'test-app-tracking-service',
    activityPerformedEnv: 'test-app-demo',
    activityName: 'Purchase',
    ...overrides,
  };
}

describe('T-INT-054 — POST /api/v1/activities (real AppModule, real Postgres) (e2e)', () => {
  let app: INestApplication;
  let sequelize: Sequelize;

  beforeAll(async () => {
    const unusedPortalPort = await getFreePort();

    process.env.ACTIVITY_INGEST_REST_TOKEN = TOKEN;
    process.env.FIELD_ENCRYPTION_AES_KEY = Buffer.alloc(32, 3).toString('base64');
    process.env.FIELD_ENCRYPTION_HMAC_KEY = Buffer.alloc(32, 4).toString('base64');

    // Deliberately unreachable — see this file's own header.
    process.env.PORTAL_GRPC_HOST = 'localhost';
    process.env.PORTAL_GRPC_PORT = String(unusedPortalPort);
    process.env.PORTAL_GRPC_TIMEOUT_MS = '1000';
    delete process.env.PORTAL_GRPC_TLS_CA_PATH;
    delete process.env.PORTAL_GRPC_TLS_CERT_PATH;
    delete process.env.PORTAL_GRPC_TLS_KEY_PATH;
    process.env.PORTAL_CONFIG_TENANT_IDS = String(TENANT_ID);

    sequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
    });
    await sequelize.authenticate();

    await sequelize.query(
      `INSERT INTO realtime_activity_processing.campaign_config_snapshot
         (tenant_id, campaign_code, config_version, is_active, payload, fetched_at, updated_at)
       VALUES (:tenantId, :campaignCode, 'hash-1', true, CAST(:payload AS jsonb), now(), now())`,
      {
        type: QueryTypes.RAW,
        replacements: {
          tenantId: TENANT_ID,
          campaignCode: CAMPAIGN_CODE,
          payload: JSON.stringify(buildCampaignPayload()),
        },
      },
    );

    // ConfigModule is @Global(), but that only broadcasts once something in the module tree
    // actually imports it — same reasoning src/grpc/grpc-server.main.ts's own
    // `GrpcMicroserviceRootModule` documents for pairing `[ConfigModule, GrpcModule]` together,
    // mirrored here since `app.module.ts`'s real composition root does the identical pairing.
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, ActivityIngestRestModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.campaign_config_snapshot WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.close();
    await app.close();
  });

  // TC-1
  it('TC-1: a matching activity is accepted, persisted with source_transport = REST', async () => {
    const body = baseBody();

    const response = await request(app.getHttpServer())
      .post('/api/v1/activities')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('accepted');
    expect(response.body.matchedTrackerComponents).toEqual(['COMP1']);

    const rows = await sequelize.query<{ source_transport: string; campaign_code: string }>(
      `SELECT source_transport, campaign_code FROM realtime_activity_processing.activity_logs
         WHERE tenant_id = :tenantId AND activity_code = 'PURCHASE'`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source_transport).toBe('REST');
    expect(rows[0].campaign_code).toBe(CAMPAIGN_CODE);
  });

  // TC-2 (negative)
  it('TC-2: no Authorization header — 401, no row inserted', async () => {
    const body = baseBody({ customerId: `cust-${randomUUID()}` });

    const response = await request(app.getHttpServer()).post('/api/v1/activities').send(body);

    expect(response.status).toBe(401);
  });

  // TC-3 (negative)
  it('TC-3: an incorrect bearer token — 401', async () => {
    const body = baseBody({ customerId: `cust-${randomUUID()}` });

    const response = await request(app.getHttpServer())
      .post('/api/v1/activities')
      .set('Authorization', 'Bearer not-the-real-token')
      .send(body);

    expect(response.status).toBe(401);
  });

  // TC-4 (negative)
  it('TC-4: a body missing tenantId — 400, descriptive validation error', async () => {
    const { tenantId: _omit, ...body } = baseBody();

    const response = await request(app.getHttpServer())
      .post('/api/v1/activities')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/tenantId/);
  });

  // TC-5 — zero active tracker components matched is a normal, logged no-op, not an error.
  it('TC-5: an activity matching no active tracker component is accepted with an empty match list', async () => {
    const body = baseBody({
      customerId: `cust-${randomUUID()}`,
      activityCode: 'NO_SUCH_ACTIVITY_CODE',
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/activities')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'accepted', matchedTrackerComponents: [] });
  });
});
