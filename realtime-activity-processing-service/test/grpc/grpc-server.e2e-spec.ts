/**
 * T-RAP-022. Real round trip: a real `@grpc/grpc-js` client, over real mTLS (ephemeral CA/server/
 * client certificates, `test-cert-authority.ts`), against a real, listening
 * `GrpcMicroserviceRootModule` (`src/grpc/grpc-server.main.ts`'s own composition root) backed by
 * the real, already-migrated `realtime_activity_processing` schema on the real local Postgres 16
 * server (root `CLAUDE.md`) — same "assert the observable property, not the implementation string"
 * discipline this project's own `activity-logs.repository.spec.ts` already established
 * (`AGENT-PROTOCOL.md` §3): only a real TLS handshake against a real server can actually prove
 * TC-3's connection/guard-level rejection, not a mocked transport.
 *
 * No portal gRPC server is running in this environment — `PORTAL_GRPC_PORT` is deliberately pointed
 * at a second, guaranteed-unused free port so `CampaignConfigCacheService.bootstrap()`'s own
 * `ListActiveCampaigns` call fails fast (connection refused) rather than racing a real portal
 * process that might otherwise consider this test's locally-seeded campaign "vanished" (only a
 * *successful* `ListActiveCampaigns` response that omits a campaign code triggers that path —
 * `campaign-config-cache.service.ts`'s own `markCampaignVanished`).
 *
 * Deviation from the task file's literal verification step 1 command (`npm test -- grpc`): no
 * `test:e2e` script exists in `package.json` — this project's single `testRegex` already matches
 * both `.spec.ts` and `.e2e-spec.ts`, so `npm test -- grpc` runs this file too (same precedent
 * `promo-code-service`'s own `grpc-server.e2e-spec.ts` header documents for the sibling project).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import type { INestMicroservice } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { createGrpcMicroservice } from '@/grpc/grpc-server.main';
import { ActivityIngestionService } from '@/modules/activity-mapping/activity-ingestion.service';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-config.client';
import { TestCertAuthority, type IssuedCertificate } from './support/test-cert-authority';
import {
  createTestClient,
  callSubmitActivity,
  type ActivityIngestServiceTestClient,
} from './support/test-grpc-client';

jest.setTimeout(30000);

const ALLOWED_IDENTITY = 'rap-e2e-allowed-client';
const DENIED_IDENTITY = 'rap-e2e-denied-client';
const TENANT_ID = 930_000 + Math.floor(Math.random() * 69_999);
const CAMPAIGN_CODE = `CAMP-T-RAP-022-${TENANT_ID}`;

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
        name: 'T-RAP-022 e2e merchant',
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
        name: 'T-RAP-022 e2e tracker',
        completionLogic: 'ALL',
        completionThreshold: 1,
        status: 'active',
        components: [
          {
            componentId: 801,
            componentCode: 'COMP1',
            name: 'T-RAP-022 e2e component',
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

describe('T-RAP-022 — gRPC server (real mTLS, real Postgres) (e2e)', () => {
  let ca: TestCertAuthority;
  let microserviceApp: INestMicroservice;
  let sequelize: Sequelize;
  let ingestionService: ActivityIngestionService;
  let address: string;
  let allowedCert: IssuedCertificate;
  let deniedCert: IssuedCertificate;

  beforeAll(async () => {
    ca = TestCertAuthority.build();
    const [grpcPort, unusedPortalPort] = await Promise.all([getFreePort(), getFreePort()]);
    address = `localhost:${grpcPort}`;

    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${ALLOWED_IDENTITY}:${TENANT_ID}`;
    delete process.env.GRPC_SERVER_ENABLED;

    // Deliberately unreachable — see this file's own header for why.
    process.env.PORTAL_GRPC_HOST = 'localhost';
    process.env.PORTAL_GRPC_PORT = String(unusedPortalPort);
    process.env.PORTAL_GRPC_TIMEOUT_MS = '1000';
    delete process.env.PORTAL_GRPC_TLS_CA_PATH;
    delete process.env.PORTAL_GRPC_TLS_CERT_PATH;
    delete process.env.PORTAL_GRPC_TLS_KEY_PATH;

    process.env.PORTAL_CONFIG_TENANT_IDS = String(TENANT_ID);
    process.env.FIELD_ENCRYPTION_AES_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.FIELD_ENCRYPTION_HMAC_KEY = Buffer.alloc(32, 2).toString('base64');

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

    // Seed the campaign this test matches against directly into the local durable cache table —
    // `CampaignConfigCacheService.bootstrap()` (triggered by app init below) rebuilds its
    // in-memory index from this table first, before attempting (and, per this file's header,
    // failing fast at) a portal refresh.
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

    const app = await createGrpcMicroservice();
    if (app === null) {
      throw new Error('expected createGrpcMicroservice() to return a microservice in this test');
    }
    microserviceApp = app;
    await microserviceApp.listen();

    ingestionService = microserviceApp.get(ActivityIngestionService);

    allowedCert = ca.issueClientCert(ALLOWED_IDENTITY);
    deniedCert = ca.issueClientCert(DENIED_IDENTITY);
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
    await microserviceApp.close();
    ca.cleanup();
  });

  function allowedClient(): ActivityIngestServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(allowedCert.keyPath),
      readFileSync(allowedCert.certPath),
    );
    return createTestClient(address, credentials);
  }

  function deniedClient(): ActivityIngestServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(deniedCert.keyPath),
      readFileSync(deniedCert.certPath),
    );
    return createTestClient(address, credentials);
  }

  /** No client key/cert pair presented at all — just the CA, to verify the server cert. */
  function noCertClient(): ActivityIngestServiceTestClient {
    const credentials = grpc.credentials.createSsl(readFileSync(ca.caCertPath));
    return createTestClient(address, credentials);
  }

  function baseRequest(overrides: Record<string, string> = {}) {
    return {
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
      ...overrides,
    };
  }

  // TC-1
  it('TC-1: a valid request matching one active tracker component returns accepted with the matched component code', async () => {
    const client = allowedClient();

    const response = await callSubmitActivity(client, baseRequest());

    expect(response.status).toBe('accepted');
    expect(response.matchedTrackerComponents).toEqual(['COMP1']);
    expect(response.correlationId.length).toBeGreaterThan(0);
    client.close();
  });

  // TC-2
  it('TC-2: the same request submitted twice returns duplicate the second time', async () => {
    const client = allowedClient();
    const request = baseRequest();

    const first = await callSubmitActivity(client, request);
    const second = await callSubmitActivity(client, request);

    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
    // proto3 `repeated string` with zero entries deserializes to `undefined` on this client's own
    // loader options (no `defaults: true`), not `[]` — both mean "no matched components".
    expect(second.matchedTrackerComponents ?? []).toEqual([]);
    client.close();
  });

  // TC-3
  it('TC-3: no client certificate presented is rejected before the handler runs', async () => {
    const client = noCertClient();

    await expect(callSubmitActivity(client, baseRequest())).rejects.toMatchObject({
      code: grpc.status.UNAVAILABLE,
    });
    client.close();
  });

  // TC-3 (continued): a valid-TLS certificate that is simply not on the allowlist.
  it('TC-3: a client certificate not on the allowlist is rejected with PERMISSION_DENIED', async () => {
    const client = deniedClient();

    await expect(callSubmitActivity(client, baseRequest())).rejects.toMatchObject({
      code: grpc.status.PERMISSION_DENIED,
    });
    client.close();
  });

  // TC-4
  it('TC-4: activity_value = "not-a-number" is rejected with INVALID_ARGUMENT, not a crash', async () => {
    const client = allowedClient();

    await expect(
      callSubmitActivity(client, baseRequest({ activityValue: 'not-a-number' })),
    ).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    client.close();
  });

  // TC-5
  it('TC-5: activity_performed_date with no UTC offset is rejected with INVALID_ARGUMENT', async () => {
    const client = allowedClient();

    await expect(
      callSubmitActivity(client, baseRequest({ activityPerformedDate: '2026-09-01 10:00:00' })),
    ).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    client.close();
  });

  // TC-6: cross-transport parity. The Kafka consumer (T-RAP-023) does not exist yet, so this
  // simulates it by calling the exact same domain method (`ActivityIngestionService.ingest`)
  // directly with `sourceTransport: 'KAFKA'` — proving the mapping outcome (which campaign/
  // tracker/component this activity resolves to) is identical regardless of which transport
  // constructed the `InboundActivity`, since both ultimately call the one shared method
  // (`ARCHITECTURE.md` §6, `AGENT-PROTOCOL.md` R5). Same precedent
  // `promo-code-service/test/grpc/grpc-server.e2e-spec.ts`'s own TC-13 already set for the sibling
  // project.
  it('TC-6: identical activity content produces the identical mapping outcome via gRPC and via a simulated Kafka-transport call', async () => {
    const client = allowedClient();
    const grpcRequest = baseRequest();

    const grpcResponse = await callSubmitActivity(client, grpcRequest);
    expect(grpcResponse.status).toBe('accepted');

    const kafkaResult = await ingestionService.ingest({
      tenantId: TENANT_ID,
      customerId: grpcRequest.customerId,
      customerIdType: grpcRequest.customerIdType,
      activityPerformedDate: new Date(grpcRequest.activityPerformedDate),
      activityCode: grpcRequest.activityCode,
      activityType: grpcRequest.activityType,
      activityCategory: grpcRequest.activityCategory,
      activityValue: grpcRequest.activityValue,
      activityValueUnit: grpcRequest.activityValueUnit,
      channel: grpcRequest.channel,
      activityPerformedEnv: grpcRequest.activityPerformedEnv,
      activityName: grpcRequest.activityName,
      activityEventId: `${grpcRequest.activityEventId}-kafka-sim`,
      sourceTransport: 'KAFKA',
    });

    expect(kafkaResult.status).toBe('accepted');
    expect(kafkaResult.matchedTrackerComponents).toEqual(['COMP1']);

    const rows = await sequelize.query<{
      campaign_code: string;
      tracker_code: string;
      tracker_component_code: string;
      source_transport: string;
    }>(
      `SELECT campaign_code, tracker_code, tracker_component_code, source_transport
         FROM realtime_activity_processing.activity_logs
        WHERE tenant_id = :tenantId AND dedup_key IN (:grpcDedupKey, :kafkaDedupKey)
        ORDER BY source_transport`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: TENANT_ID,
          grpcDedupKey: grpcRequest.activityEventId,
          kafkaDedupKey: `${grpcRequest.activityEventId}-kafka-sim`,
        },
      },
    );

    expect(rows).toHaveLength(2);
    // ORDER BY source_transport ascending: 'GRPC' < 'KAFKA'.
    const [grpcRow, kafkaRow] = rows;
    expect(grpcRow.source_transport).toBe('GRPC');
    expect(kafkaRow.source_transport).toBe('KAFKA');
    expect(grpcRow.campaign_code).toBe(kafkaRow.campaign_code);
    expect(grpcRow.tracker_code).toBe(kafkaRow.tracker_code);
    expect(grpcRow.tracker_component_code).toBe(kafkaRow.tracker_component_code);
    client.close();
  });
});
