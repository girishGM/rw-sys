/**
 * T-RAP-010. Real end-to-end coverage of TC-1/TC-2/TC-3 and this task's own Verification steps
 * 2-3: a real `@grpc/grpc-js` mock server implementing `proto/campaign_config.proto` field-for-
 * field (implementation note 4 — this is that mock, and it implements every RPC the real contract
 * declares, returning `UNIMPLEMENTED` for the three T-RAP-010 doesn't call), and the real local
 * Postgres 16 server (root `CLAUDE.md`), connected as the real least-privilege `rap_app` role —
 * same convention `test/database/migrations.spec.ts` (T-RAP-002) already established.
 *
 * No `AppModule`/`nest start` involved: `campaign-config-cache.module.ts`'s own header explains
 * why (not wired into `AppModule` by this task, same as `IdempotencyModule`) — this harness
 * constructs the real classes directly, which is what "start the app against the mock portal"
 * means for a module with no HTTP surface of its own yet.
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
} from '@/modules/campaign-cache/campaign-config.client';
import { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import {
  ActivityExternalCodeMapRepository,
  CampaignConfigSnapshotRepository,
} from '@/modules/campaign-cache/campaign-config-snapshot.repository';

// ---------------------------------------------------------------------------------------------
// Mock portal — implements the real proto shape, not a simplified stand-in (implementation note 4).
// RPCs implemented: ListActiveCampaigns, GetCampaignConfig (both exercised by this task),
// WatchCampaignConfig (kept open, not exercised — T-RAP-011's own concern), ResolveRuleVersion /
// ResolveRewardVersion / GetBudgetStatus (UNIMPLEMENTED — not used by this task either).
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
}

function unimplemented(callback: grpc.sendUnaryData<unknown>): void {
  callback({
    name: 'Unimplemented',
    message: 'not used by T-RAP-010',
    code: grpc.status.UNIMPLEMENTED,
  });
}

function buildHandlers(state: MockPortalState): grpc.UntypedServiceImplementation {
  return {
    listActiveCampaigns: (
      call: grpc.ServerUnaryCall<{ tenantId: number }, CampaignConfigListProto>,
      callback: grpc.sendUnaryData<CampaignConfigListProto>,
    ) => {
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
    watchCampaignConfig: (call: grpc.ServerWritableStream<{ tenantId: number }, unknown>) => {
      call.on('cancelled', () => call.end());
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
  return new Promise((resolve) => {
    server.tryShutdown(() => resolve());
  });
}

/** A port nothing is listening on: bind an ephemeral server, note its port, shut it down
 * immediately. Standing in for "the mock portal is unreachable" (TC-2/TC-3) without depending on
 * any specific port being free in advance. */
async function unreachablePort(): Promise<number> {
  const { server, port } = await startMockServer({ campaignsByTenant: new Map() });
  await stopMockServer(server);
  return port;
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

describe('T-RAP-010 — campaign config cache, real mock portal + real Postgres', () => {
  let sequelize: Sequelize;
  const usedTenantIds: number[] = [];
  const savedTenantIdsEnv = process.env.PORTAL_CONFIG_TENANT_IDS;

  function freshTenantId(): number {
    const id = 930_000 + Math.floor(Math.random() * 69_999) + usedTenantIds.length;
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
      await sequelize.query(
        'DELETE FROM realtime_activity_processing.activity_external_code_map WHERE tenant_id = :tenant_id',
        { type: QueryTypes.RAW, replacements: { tenant_id: tenantId } },
      );
    }
    await sequelize.close();
    if (savedTenantIdsEnv === undefined) {
      delete process.env.PORTAL_CONFIG_TENANT_IDS;
    } else {
      process.env.PORTAL_CONFIG_TENANT_IDS = savedTenantIdsEnv;
    }
  });

  function buildRealService(host: string, port: number): CampaignConfigCacheService {
    const client = new CampaignConfigClient({ host, port, timeoutMs: 2_000 });
    const snapshotRepo = new CampaignConfigSnapshotRepository(sequelize);
    const externalCodeRepo = new ActivityExternalCodeMapRepository(sequelize);
    return new CampaignConfigCacheService(client, snapshotRepo, externalCodeRepo);
  }

  // TC-1 + Verification step 2.
  it('TC-1: no local snapshot, mock portal reachable — bulk fetch succeeds and the snapshot row matches the mock response', async () => {
    const tenantId = freshTenantId();
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);
    const campaign = buildCampaign(tenantId);
    const { server, port } = await startMockServer({
      campaignsByTenant: new Map([[tenantId, [campaign]]]),
    });

    try {
      const service = buildRealService('127.0.0.1', port);
      await expect(service.bootstrap()).resolves.toBeUndefined();

      // In-memory cache is populated (TC-4-equivalent, proving the whole chain end to end).
      expect(service.lookupByActivityCode(tenantId, 'ACT_PURCHASE')).toHaveLength(1);

      // Verification step 2: row present, payload matches the mock response.
      const [row] = await sequelize.query<{
        campaign_code: string;
        is_active: boolean;
        payload: CampaignConfigProto;
      }>(
        `SELECT campaign_code, is_active, payload FROM realtime_activity_processing.campaign_config_snapshot
           WHERE tenant_id = :tenant_id AND campaign_code = :campaign_code`,
        { type: QueryTypes.SELECT, replacements: { tenant_id: tenantId, campaign_code: 'CAMP1' } },
      );
      expect(row).toBeDefined();
      expect(row.is_active).toBe(true);
      expect(row.payload.campaignCode).toBe('CAMP1');
      expect(row.payload.etag).toBe('etag-1');
      expect(row.payload.trackers[0].components[0].componentCode).toBe('COMP1');
    } finally {
      await stopMockServer(server);
    }
  });

  // TC-3.
  it('TC-3: no local snapshot, mock portal unreachable — fails startup with a clear error', async () => {
    const tenantId = freshTenantId();
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);
    const port = await unreachablePort();

    const service = buildRealService('127.0.0.1', port);
    await expect(service.bootstrap()).rejects.toThrow(/Cold start failed/);
  });

  // TC-2 + Verification step 3 ("kill the mock portal, restart the app").
  it('TC-2/step-3: boots from the local snapshot, with a warning, when the portal is unreachable after a prior successful warm', async () => {
    const tenantId = freshTenantId();
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);
    const campaign = buildCampaign(tenantId);
    const { server: liveServer, port: livePort } = await startMockServer({
      campaignsByTenant: new Map([[tenantId, [campaign]]]),
    });

    // "Start the app" the first time, against a live mock portal — this is what populates the
    // local snapshot TC-2 then boots from.
    const firstProcess = buildRealService('127.0.0.1', livePort);
    await firstProcess.bootstrap();
    expect(firstProcess.lookupByActivityCode(tenantId, 'ACT_PURCHASE')).toHaveLength(1);

    // Kill the mock portal.
    await stopMockServer(liveServer);
    const deadPort = await unreachablePort();

    // "Restart the app" — a brand new service instance (fresh in-memory maps), same DB state,
    // pointed at the now-dead mock portal.
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const restarted = buildRealService('127.0.0.1', deadPort);
      await expect(restarted.bootstrap()).resolves.toBeUndefined();
      expect(restarted.lookupByActivityCode(tenantId, 'ACT_PURCHASE')).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('booting from the last known local snapshot'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
