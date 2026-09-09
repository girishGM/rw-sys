/**
 * T-RTS-020. Two kinds of coverage in one file (this task's "Files owned" list grants exactly one
 * client spec, unlike RAP's split between a pure-unit client spec and a separate mock-portal
 * e2e-spec):
 *
 *  1. Pure, synchronous unit tests for `loadCampaignHierarchyClientOptions`/
 *     `resolveConfiguredTenantIds` — no network, no DB.
 *  2. Real wire-level round trips against a `@grpc/grpc-js` mock server implementing
 *     `proto/campaign_config.proto` field-for-field (TC-1..3 + Verification step 1), using an
 *     in-memory fake repository (`CampaignHierarchyCacheWriter`) rather than real Postgres — the
 *     real-Postgres half of this table's behaviour (upsert/markInactive semantics, the unique
 *     constraint) is `campaign-hierarchy-cache.repository.spec.ts`'s own job; duplicating it here
 *     would just be the same coverage twice.
 */
import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  CampaignHierarchyClient,
  DEFAULT_PORTAL_GRPC_PORT,
  DEFAULT_PORTAL_GRPC_TIMEOUT_MS,
  DEFAULT_WATCH_RECONNECT_DELAY_MS,
  loadCampaignHierarchyClientOptions,
  resolveConfiguredTenantIds,
} from '@/modules/campaign-cache/campaign-hierarchy.client';
import type {
  CampaignConfigListProto,
  CampaignConfigProto,
  ConfigChangeEventProto,
} from '@/modules/campaign-cache/campaign-hierarchy.client';
import type {
  CampaignHierarchyCacheWriter,
  UpsertCampaignHierarchyData,
} from '@/modules/campaign-cache/campaign-hierarchy-cache.repository';

// =================================================================================================
// Part 1 — pure env-parsing unit tests.
// =================================================================================================

const CLIENT_ENV_KEYS = [
  'PORTAL_GRPC_HOST',
  'PORTAL_GRPC_PORT',
  'PORTAL_GRPC_TIMEOUT_MS',
  'PORTAL_GRPC_WATCH_RECONNECT_MS',
  'PORTAL_GRPC_TLS_CA_PATH',
  'PORTAL_GRPC_TLS_CERT_PATH',
  'PORTAL_GRPC_TLS_KEY_PATH',
] as const;

describe('loadCampaignHierarchyClientOptions', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(CLIENT_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of CLIENT_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CLIENT_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('defaults host/port/timeout/reconnect delay when nothing is configured, and no TLS material', () => {
    const options = loadCampaignHierarchyClientOptions();
    expect(options).toEqual({
      host: 'localhost',
      port: DEFAULT_PORTAL_GRPC_PORT,
      timeoutMs: DEFAULT_PORTAL_GRPC_TIMEOUT_MS,
      reconnectDelayMs: DEFAULT_WATCH_RECONNECT_DELAY_MS,
    });
  });

  it('reads a custom host/port/timeout/reconnect delay from the environment', () => {
    process.env.PORTAL_GRPC_HOST = 'portal.internal';
    process.env.PORTAL_GRPC_PORT = '60123';
    process.env.PORTAL_GRPC_TIMEOUT_MS = '9000';
    process.env.PORTAL_GRPC_WATCH_RECONNECT_MS = '1500';

    const options = loadCampaignHierarchyClientOptions();
    expect(options.host).toBe('portal.internal');
    expect(options.port).toBe(60123);
    expect(options.timeoutMs).toBe(9000);
    expect(options.reconnectDelayMs).toBe(1500);
  });

  it('rejects a non-numeric PORTAL_GRPC_PORT', () => {
    process.env.PORTAL_GRPC_PORT = 'not-a-port';
    expect(() => loadCampaignHierarchyClientOptions()).toThrow(/PORTAL_GRPC_PORT/);
  });

  it('rejects a zero/negative PORTAL_GRPC_TIMEOUT_MS', () => {
    process.env.PORTAL_GRPC_TIMEOUT_MS = '0';
    expect(() => loadCampaignHierarchyClientOptions()).toThrow(/PORTAL_GRPC_TIMEOUT_MS/);
  });

  it('rejects a zero/negative PORTAL_GRPC_WATCH_RECONNECT_MS', () => {
    process.env.PORTAL_GRPC_WATCH_RECONNECT_MS = '-1';
    expect(() => loadCampaignHierarchyClientOptions()).toThrow(/PORTAL_GRPC_WATCH_RECONNECT_MS/);
  });

  describe('TLS material', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'rts-grpc-client-tls-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a partial TLS configuration (only some of the three paths set)', () => {
      const caPath = join(dir, 'ca.pem');
      writeFileSync(caPath, 'fake-ca');
      process.env.PORTAL_GRPC_TLS_CA_PATH = caPath;

      expect(() => loadCampaignHierarchyClientOptions()).toThrow(
        /must all be set together, or none of them/,
      );
    });

    it('loads all three certs when fully configured', () => {
      const caPath = join(dir, 'ca.pem');
      const certPath = join(dir, 'cert.pem');
      const keyPath = join(dir, 'key.pem');
      writeFileSync(caPath, 'fake-ca');
      writeFileSync(certPath, 'fake-cert');
      writeFileSync(keyPath, 'fake-key');
      process.env.PORTAL_GRPC_TLS_CA_PATH = caPath;
      process.env.PORTAL_GRPC_TLS_CERT_PATH = certPath;
      process.env.PORTAL_GRPC_TLS_KEY_PATH = keyPath;

      const options = loadCampaignHierarchyClientOptions();
      expect(options.tls?.rootCerts.toString()).toBe('fake-ca');
      expect(options.tls?.clientCert.toString()).toBe('fake-cert');
      expect(options.tls?.clientKey.toString()).toBe('fake-key');
    });
  });
});

describe('resolveConfiguredTenantIds', () => {
  const savedEnv = process.env.PORTAL_CONFIG_TENANT_IDS;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.PORTAL_CONFIG_TENANT_IDS;
    } else {
      process.env.PORTAL_CONFIG_TENANT_IDS = savedEnv;
    }
  });

  it('throws when unset', () => {
    delete process.env.PORTAL_CONFIG_TENANT_IDS;
    expect(() => resolveConfiguredTenantIds()).toThrow(/PORTAL_CONFIG_TENANT_IDS is required/);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    process.env.PORTAL_CONFIG_TENANT_IDS = ' 100, 200 ,300';
    expect(resolveConfiguredTenantIds()).toEqual([100, 200, 300]);
  });

  it('rejects a non-positive-integer entry', () => {
    process.env.PORTAL_CONFIG_TENANT_IDS = '100,not-a-number';
    expect(() => resolveConfiguredTenantIds()).toThrow(/Invalid PORTAL_CONFIG_TENANT_IDS entry/);
  });
});

// =================================================================================================
// Part 2 — real mock portal + in-memory fake repository (TC-1..3, Verification step 1).
// =================================================================================================

function protoPath(): string {
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
  watchCalls: Set<grpc.ServerWritableStream<{ tenantId: number }, ConfigChangeEventProto>>;
}

function unimplemented(callback: grpc.sendUnaryData<unknown>): void {
  callback({
    name: 'Unimplemented',
    message: 'not used by T-RTS-020',
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
        sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS'],
        sectionsOmitted: ['RULES', 'REWARDS', 'CAPS'],
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
      state.watchCalls.add(call);
      call.on('cancelled', () => {
        state.watchCalls.delete(call);
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
  return new Promise((resolve) => {
    server.tryShutdown(() => resolve());
  });
}

/** A port nothing is listening on: bind an ephemeral server, note its port, shut it down
 * immediately. Standing in for "the mock portal is unreachable" (TC-3). */
async function unreachablePort(): Promise<number> {
  const { server, port } = await startMockServer({
    campaignsByTenant: new Map(),
    watchCalls: new Set(),
  });
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
        activities: [],
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
        components: [],
      },
    ],
    rules: [],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS'],
    sectionsOmitted: ['RULES', 'REWARDS', 'CAPS'],
    ...overrides,
  };
}

class FakeCampaignHierarchyCacheWriter implements CampaignHierarchyCacheWriter {
  readonly rows = new Map<string, UpsertCampaignHierarchyData>();

  private key(tenantId: number, campaignCode: string): string {
    return `${tenantId}::${campaignCode}`;
  }

  async upsert(data: UpsertCampaignHierarchyData): Promise<void> {
    this.rows.set(this.key(data.tenantId, data.campaignCode), data);
  }

  async findCampaignCodesForTenant(tenantId: number): Promise<string[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .map((row) => row.campaignCode);
  }

  async markInactive(tenantId: number, campaignCode: string): Promise<void> {
    const key = this.key(tenantId, campaignCode);
    const existing = this.rows.get(key);
    if (existing) {
      this.rows.set(key, { ...existing, isActive: false });
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor: condition never became true within the timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('CampaignHierarchyClient — real mock portal, in-memory fake repository', () => {
  const savedTenantIdsEnv = process.env.PORTAL_CONFIG_TENANT_IDS;

  afterAll(() => {
    if (savedTenantIdsEnv === undefined) {
      delete process.env.PORTAL_CONFIG_TENANT_IDS;
    } else {
      process.env.PORTAL_CONFIG_TENANT_IDS = savedTenantIdsEnv;
    }
  });

  function buildClient(
    host: string,
    port: number,
    repository: CampaignHierarchyCacheWriter,
  ): CampaignHierarchyClient {
    return new CampaignHierarchyClient(
      { host, port, timeoutMs: 2_000, reconnectDelayMs: 150 },
      repository,
    );
  }

  // TC-1 + Verification step 1.
  it('TC-1: receives a campaign config snapshot — campaign_hierarchy_cache row created with names/hierarchy', async () => {
    const tenantId = 900_001;
    const campaign = buildCampaign(tenantId);
    const { server, port } = await startMockServer({
      campaignsByTenant: new Map([[tenantId, [campaign]]]),
      watchCalls: new Set(),
    });
    const repository = new FakeCampaignHierarchyCacheWriter();
    const client = buildClient('127.0.0.1', port, repository);

    try {
      await expect(client.warmTenant(tenantId)).resolves.toBe(true);

      const row = repository.rows.get(`${tenantId}::CAMP1`);
      expect(row).toBeDefined();
      expect(row?.isActive).toBe(true);
      expect(row?.configVersion).toBe('hash-1');
      expect((row?.hierarchy as CampaignConfigProto).trackers[0].trackerCode).toBe('TRK1');
      // This task's own finding: neither field has a wire source yet (proto header, BACKLOG RS-01).
      expect(row?.campaignName).toBeNull();
      expect(row?.ownerContact).toBeNull();
    } finally {
      client.onModuleDestroy();
      await stopMockServer(server);
    }
  });

  // TC-2 + Verification step 1.
  it('TC-2: a WatchCampaignConfig UPDATED invalidation for an already-cached campaign refreshes the row', async () => {
    const tenantId = 900_002;
    const campaign = buildCampaign(tenantId, { tenantId });
    const state: MockPortalState = {
      campaignsByTenant: new Map([[tenantId, [campaign]]]),
      watchCalls: new Set(),
    };
    const { server, port } = await startMockServer(state);
    const repository = new FakeCampaignHierarchyCacheWriter();
    const client = buildClient('127.0.0.1', port, repository);
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);

    try {
      await client.onModuleInit();
      expect(repository.rows.get(`${tenantId}::CAMP1`)?.configVersion).toBe('hash-1');

      await waitFor(() => state.watchCalls.size === 1);

      // The portal's own config changed — the client must re-fetch, not just trust the event.
      state.campaignsByTenant.set(tenantId, [
        buildCampaign(tenantId, { tenantId, configHash: 'hash-2', etag: 'etag-2' }),
      ]);
      const event: ConfigChangeEventProto = {
        campaignId: campaign.campaignId,
        campaignCode: 'CAMP1',
        tenantId,
        changeType: 'UPDATED',
        etag: 'etag-2',
        occurredAt: new Date().toISOString(),
      };
      for (const call of state.watchCalls) {
        call.write(event);
      }

      await waitFor(() => repository.rows.get(`${tenantId}::CAMP1`)?.configVersion === 'hash-2');
      expect(repository.rows.get(`${tenantId}::CAMP1`)?.isActive).toBe(true);
    } finally {
      client.onModuleDestroy();
      await stopMockServer(server);
    }
  });

  it('a WatchCampaignConfig ENDED invalidation marks the cached row inactive without a GetCampaignConfig round trip', async () => {
    const tenantId = 900_003;
    const campaign = buildCampaign(tenantId, { tenantId });
    const state: MockPortalState = {
      campaignsByTenant: new Map([[tenantId, [campaign]]]),
      watchCalls: new Set(),
    };
    const { server, port } = await startMockServer(state);
    const repository = new FakeCampaignHierarchyCacheWriter();
    const client = buildClient('127.0.0.1', port, repository);
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);

    try {
      await client.onModuleInit();
      await waitFor(() => state.watchCalls.size === 1);

      // Removed from the portal's own active set entirely — a real ENDED wouldn't leave the
      // campaign gettable at all, so removing it here proves no GetCampaignConfig call happened.
      state.campaignsByTenant.set(tenantId, []);
      const event: ConfigChangeEventProto = {
        campaignId: campaign.campaignId,
        campaignCode: 'CAMP1',
        tenantId,
        changeType: 'ENDED',
        etag: '',
        occurredAt: new Date().toISOString(),
      };
      for (const call of state.watchCalls) {
        call.write(event);
      }

      await waitFor(() => repository.rows.get(`${tenantId}::CAMP1`)?.isActive === false);
    } finally {
      client.onModuleDestroy();
      await stopMockServer(server);
    }
  });

  // TC-3 + Verification step 1.
  it('TC-3: portal unreachable at startup — onModuleInit resolves (service still boots), cache stays empty, logged clearly', async () => {
    const tenantId = 900_004;
    const port = await unreachablePort();
    const repository = new FakeCampaignHierarchyCacheWriter();
    const client = buildClient('127.0.0.1', port, repository);
    process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(client.onModuleInit()).resolves.toBeUndefined();
      expect(repository.rows.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('booting empty/stale'));
    } finally {
      client.onModuleDestroy();
      warnSpy.mockRestore();
    }
  });

  it('a missing PORTAL_CONFIG_TENANT_IDS never crashes onModuleInit either — logged clearly, cache stays empty', async () => {
    delete process.env.PORTAL_CONFIG_TENANT_IDS;
    const repository = new FakeCampaignHierarchyCacheWriter();
    const client = buildClient('127.0.0.1', DEFAULT_PORTAL_GRPC_PORT, repository);

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(client.onModuleInit()).resolves.toBeUndefined();
      expect(repository.rows.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('campaign_hierarchy_cache will not be warmed'),
      );
    } finally {
      client.onModuleDestroy();
      warnSpy.mockRestore();
    }
  });
});
