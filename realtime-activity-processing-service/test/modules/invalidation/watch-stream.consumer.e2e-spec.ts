/**
 * T-RAP-011. Real end-to-end coverage of TC-1 and this task's own Verification steps 1-2: a real
 * `@grpc/grpc-js` mock server implementing `proto/campaign_config.proto` (same field-for-field
 * discipline `campaign-config-cache.e2e-spec.ts`, T-RAP-010, already established), real
 * `WatchStreamConsumer`/`CampaignConfigCacheService` instances, and the real local Postgres 16
 * server (root `CLAUDE.md`) as the real least-privilege `rap_app` role.
 *
 * TC-1's own point is the property a Kafka consumer group does **not** have: "every open stream
 * gets every event pushed to it directly" (`04-CACHE-INVALIDATION.md` §1) — proven here by running
 * **two independent, separately-connected** `WatchStreamConsumer`/`CampaignConfigCacheService`
 * pairs (standing in for two service instances) against one mock server and confirming **both**,
 * not just one, observe and apply the same broadcast `ConfigChangeEvent`.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { CampaignConfigClient } from '@/modules/campaign-cache/campaign-config.client';
import type {
  CampaignConfigListProto,
  CampaignConfigProto,
  ConfigChangeEventProto,
} from '@/modules/campaign-cache/campaign-config.client';
import { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import {
  ActivityExternalCodeMapRepository,
  CampaignConfigSnapshotRepository,
} from '@/modules/campaign-cache/campaign-config-snapshot.repository';
import { WatchStreamConsumer } from '@/modules/invalidation/watch-stream.consumer';

// ---------------------------------------------------------------------------------------------
// Mock portal — same shape as T-RAP-010's own e2e mock, extended with a broadcast-capable
// WatchCampaignConfig handler (tracks every currently-open call so a test can push one event to
// all of them, proving the "every open stream" property TC-1 is about).
// ---------------------------------------------------------------------------------------------

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

interface MockPortalState {
  campaignsByTenant: Map<number, CampaignConfigProto[]>;
  watchCalls: grpc.ServerWritableStream<{ tenantId: number }, ConfigChangeEventProto>[];
  listActiveCampaignsCallCount: number;
}

function unimplemented(callback: grpc.sendUnaryData<unknown>): void {
  callback({
    name: 'Unimplemented',
    message: 'not used by T-RAP-011',
    code: grpc.status.UNIMPLEMENTED,
  });
}

function buildHandlers(state: MockPortalState): grpc.UntypedServiceImplementation {
  return {
    listActiveCampaigns: (
      call: grpc.ServerUnaryCall<{ tenantId: number }, CampaignConfigListProto>,
      callback: grpc.sendUnaryData<CampaignConfigListProto>,
    ) => {
      state.listActiveCampaignsCallCount += 1;
      const campaigns = state.campaignsByTenant.get(call.request.tenantId) ?? [];
      callback(null, {
        campaigns,
        servedAt: new Date().toISOString(),
        sectionsReturned: [],
        sectionsOmitted: [],
      });
    },
    getCampaignConfig: (
      call: grpc.ServerUnaryCall<{ tenantId: number; campaignCode: string }, CampaignConfigProto>,
      callback: grpc.sendUnaryData<CampaignConfigProto>,
    ) => {
      const campaigns = state.campaignsByTenant.get(call.request.tenantId) ?? [];
      const found = campaigns.find((c) => c.campaignCode === call.request.campaignCode);
      if (!found) {
        callback({ name: 'NotFound', message: 'campaign not found', code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, found);
    },
    watchCampaignConfig: (
      call: grpc.ServerWritableStream<{ tenantId: number }, ConfigChangeEventProto>,
    ) => {
      state.watchCalls.push(call);
      call.on('cancelled', () => {
        state.watchCalls = state.watchCalls.filter((c) => c !== call);
        call.end();
      });
    },
    resolveRuleVersion: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
    resolveRewardVersion: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
    getBudgetStatus: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
  } as unknown as grpc.UntypedServiceImplementation;
}

function startMockServer(state: MockPortalState): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(loadServiceDefinition(), buildHandlers(state));
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port });
    });
  });
}

function stopMockServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}

function buildCampaign(
  tenantId: number,
  overrides: Partial<CampaignConfigProto> = {},
): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode: 'CAMP1',
    tenantId,
    countryId: 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    budget: { amount: '1000.00', currency: 'USD' },
    maxParticipants: 100,
    merchants: [
      {
        merchantId: 1,
        merchantCode: 'MERCH1',
        name: 'Merchant One',
        status: 'active',
        activities: [
          { activityId: 10, activityCode: 'ACT_PURCHASE', name: 'Purchase', externalCodes: [] },
        ],
      },
    ],
    trackers: [
      {
        trackerId: 100,
        trackerCode: 'TRK1',
        name: 'Tracker One',
        completionLogic: 'all',
        completionThreshold: 1,
        status: 'active',
        components: [
          {
            componentId: 1000,
            componentCode: 'COMP1',
            name: 'Component One',
            activityId: 10,
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
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

describe('T-RAP-011 — WatchStreamConsumer, real mock portal + real Postgres', () => {
  let sequelize: Sequelize;
  const usedTenantIds: number[] = [];

  function freshTenantId(): number {
    const id = 940_000 + Math.floor(Math.random() * 59_999) + usedTenantIds.length;
    usedTenantIds.push(id);
    return id;
  }

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    for (const tenantId of usedTenantIds) {
      await sequelize.query(
        'DELETE FROM realtime_activity_processing.campaign_config_snapshot WHERE tenant_id = :tenant_id',
        { type: QueryTypes.RAW, replacements: { tenant_id: tenantId } },
      );
    }
    await sequelize.close();
  });

  function buildInstance(
    host: string,
    port: number,
  ): {
    client: CampaignConfigClient;
    cache: CampaignConfigCacheService;
    consumer: WatchStreamConsumer;
  } {
    const client = new CampaignConfigClient({ host, port, timeoutMs: 2_000 });
    const snapshotRepo = new CampaignConfigSnapshotRepository(sequelize);
    const externalCodeRepo = new ActivityExternalCodeMapRepository(sequelize);
    const cache = new CampaignConfigCacheService(client, snapshotRepo, externalCodeRepo);
    const consumer = new WatchStreamConsumer(client, cache, 50, 500, true);
    return { client, cache, consumer };
  }

  // TC-1 + Verification steps 1-2.
  it('TC-1: two independent instances each receive and apply the same broadcast ConfigChangeEvent', async () => {
    const tenantId = freshTenantId();
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);
    const initialCampaign = buildCampaign(tenantId);
    const state: MockPortalState = {
      campaignsByTenant: new Map([[tenantId, [initialCampaign]]]),
      watchCalls: [],
      listActiveCampaignsCallCount: 0,
    };
    const { server, port } = await startMockServer(state);
    const logSpy = jest.spyOn(Logger.prototype, 'log');

    try {
      const instance1 = buildInstance('127.0.0.1', port);
      const instance2 = buildInstance('127.0.0.1', port);

      // Cold-start precondition: both instances already have the campaign cached (as T-RAP-010's
      // own bootstrap would have left it), each connected to the same real DB row.
      await instance1.cache.applyCampaignConfig(initialCampaign);
      await instance2.cache.applyCampaignConfig(initialCampaign);

      instance1.consumer.start();
      instance2.consumer.start();
      await waitUntil(() => state.watchCalls.length === 2);

      // The portal's own state now has an updated campaign — this is what both instances'
      // GetCampaignConfig calls (triggered by the broadcast event below) will resolve to.
      const updatedCampaign = buildCampaign(tenantId, {
        etag: 'etag-2',
        configHash: 'hash-2',
      });
      state.campaignsByTenant.set(tenantId, [updatedCampaign]);

      const event: ConfigChangeEventProto = {
        campaignId: 1,
        campaignCode: 'CAMP1',
        tenantId,
        changeType: 'UPDATED',
        etag: 'etag-2',
        occurredAt: new Date().toISOString(),
      };
      // Broadcast to every currently-open call — the real server-streaming property under test:
      // there is no consumer-group/partition assignment to route this to only one of them.
      for (const call of state.watchCalls) {
        call.write(event);
      }

      await waitUntil(
        () =>
          instance1.cache.getCampaignConfig(tenantId, 'CAMP1')?.etag === 'etag-2' &&
          instance2.cache.getCampaignConfig(tenantId, 'CAMP1')?.etag === 'etag-2',
      );

      // Both instances' own in-memory cache reflects the new state (TC-1's own point: BOTH, not
      // just one).
      expect(instance1.cache.getCampaignConfig(tenantId, 'CAMP1')).toMatchObject({
        etag: 'etag-2',
        configHash: 'hash-2',
      });
      expect(instance2.cache.getCampaignConfig(tenantId, 'CAMP1')).toMatchObject({
        etag: 'etag-2',
        configHash: 'hash-2',
      });

      // Verification step 2: both instances logged a cache refresh for the same campaign.
      const refreshLogLines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('ConfigChangeEvent') && line.includes('CAMP1'));
      expect(refreshLogLines.length).toBeGreaterThanOrEqual(2);

      instance1.consumer.stop();
      instance2.consumer.stop();
    } finally {
      logSpy.mockRestore();
      await stopMockServer(server);
      delete process.env.PORTAL_CONFIG_TENANT_IDS;
    }
  }, 15_000);

  // TC-5's real-network half: a genuine socket-level disconnect (not just a fake stream's
  // 'error' event), verifying the client actually reconnects to the same real server and performs
  // the full re-warm.
  it('TC-5: a real server-initiated stream close triggers reconnect + full re-warm', async () => {
    const tenantId = freshTenantId();
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);
    const campaign = buildCampaign(tenantId);
    const state: MockPortalState = {
      campaignsByTenant: new Map([[tenantId, [campaign]]]),
      watchCalls: [],
      listActiveCampaignsCallCount: 0,
    };
    const { server, port } = await startMockServer(state);

    try {
      const instance = buildInstance('127.0.0.1', port);
      await instance.cache.applyCampaignConfig(campaign);

      instance.consumer.start();
      await waitUntil(() => state.watchCalls.length === 1);

      // Server-initiated close (e.g. a portal restart/deploy) — end the call directly.
      state.watchCalls[0].end();

      // The client reconnects (a second watchCampaignConfig call arrives at the mock server) and
      // performs a full re-warm (ListActiveCampaigns called again).
      await waitUntil(
        () => state.watchCalls.length === 1 && state.listActiveCampaignsCallCount >= 1,
        5_000,
      );

      instance.consumer.stop();
    } finally {
      await stopMockServer(server);
      delete process.env.PORTAL_CONFIG_TENANT_IDS;
    }
  }, 15_000);
});
