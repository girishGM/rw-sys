/**
 * T-RR-022. `CampaignConfigClient` — pure env-parsing unit tests (no network) plus a real
 * `@grpc/grpc-js` mock portal implementing `proto/campaign_config.proto` field-for-field (the same
 * "mocked portal gRPC server" convention RAP's own `campaign-config-cache.e2e-spec.ts` already
 * established, confirmed by direct read) for TC-6 (`PERMISSION_DENIED` classification) and TC-7
 * (the outgoing `sections` list is exactly `[BASIC, MERCHANTS, TRACKERS, REWARDS, CAPS]`, never
 * `RULES`).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  CAMPAIGN_CONFIG_SECTIONS,
  CampaignConfigClient,
  DEFAULT_PORTAL_GRPC_PORT,
  DEFAULT_PORTAL_GRPC_TIMEOUT_MS,
  PortalGrantNotProvisionedError,
  loadCampaignConfigClientOptions,
  loadPortalConfigTenantIds,
  type CampaignConfigProto,
} from '@/modules/processing/campaign-config.client';

const ENV_KEYS = [
  'PORTAL_GRPC_HOST',
  'PORTAL_GRPC_PORT',
  'PORTAL_GRPC_TIMEOUT_MS',
  'PORTAL_GRPC_TLS_CA_PATH',
  'PORTAL_GRPC_TLS_CERT_PATH',
  'PORTAL_GRPC_TLS_KEY_PATH',
  'PORTAL_CONFIG_TENANT_IDS',
] as const;

function withSavedEnv(fn: () => void | Promise<void>) {
  return async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    try {
      await fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  };
}

describe('loadCampaignConfigClientOptions', () => {
  it(
    'defaults host/port/timeout when nothing is configured, and no TLS material',
    withSavedEnv(() => {
      const options = loadCampaignConfigClientOptions();
      expect(options).toEqual({
        host: 'localhost',
        port: DEFAULT_PORTAL_GRPC_PORT,
        timeoutMs: DEFAULT_PORTAL_GRPC_TIMEOUT_MS,
      });
    }),
  );

  it(
    'reads a custom host/port/timeout from the environment',
    withSavedEnv(() => {
      process.env.PORTAL_GRPC_HOST = 'portal.internal';
      process.env.PORTAL_GRPC_PORT = '60123';
      process.env.PORTAL_GRPC_TIMEOUT_MS = '9000';

      const options = loadCampaignConfigClientOptions();
      expect(options.host).toBe('portal.internal');
      expect(options.port).toBe(60123);
      expect(options.timeoutMs).toBe(9000);
    }),
  );

  it(
    'rejects a non-numeric PORTAL_GRPC_PORT',
    withSavedEnv(() => {
      process.env.PORTAL_GRPC_PORT = 'not-a-port';
      expect(() => loadCampaignConfigClientOptions()).toThrow(/PORTAL_GRPC_PORT/);
    }),
  );

  it(
    'rejects a zero/negative PORTAL_GRPC_TIMEOUT_MS',
    withSavedEnv(() => {
      process.env.PORTAL_GRPC_TIMEOUT_MS = '0';
      expect(() => loadCampaignConfigClientOptions()).toThrow(/PORTAL_GRPC_TIMEOUT_MS/);
    }),
  );

  describe('TLS material', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'rr-grpc-client-tls-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it(
      'rejects a partial TLS configuration (only some of the three paths set)',
      withSavedEnv(() => {
        const caPath = join(dir, 'ca.pem');
        writeFileSync(caPath, 'fake-ca');
        process.env.PORTAL_GRPC_TLS_CA_PATH = caPath;

        expect(() => loadCampaignConfigClientOptions()).toThrow(
          /must all be set together, or none of them/,
        );
      }),
    );

    it(
      'loads all three certs when fully configured',
      withSavedEnv(() => {
        const caPath = join(dir, 'ca.pem');
        const certPath = join(dir, 'cert.pem');
        const keyPath = join(dir, 'key.pem');
        writeFileSync(caPath, 'fake-ca');
        writeFileSync(certPath, 'fake-cert');
        writeFileSync(keyPath, 'fake-key');
        process.env.PORTAL_GRPC_TLS_CA_PATH = caPath;
        process.env.PORTAL_GRPC_TLS_CERT_PATH = certPath;
        process.env.PORTAL_GRPC_TLS_KEY_PATH = keyPath;

        const options = loadCampaignConfigClientOptions();
        expect(options.tls?.rootCerts.toString()).toBe('fake-ca');
        expect(options.tls?.clientCert.toString()).toBe('fake-cert');
        expect(options.tls?.clientKey.toString()).toBe('fake-key');
      }),
    );
  });
});

describe('loadPortalConfigTenantIds', () => {
  it(
    'parses a comma-separated list of positive integers',
    withSavedEnv(() => {
      process.env.PORTAL_CONFIG_TENANT_IDS = '1, 2,3';
      expect(loadPortalConfigTenantIds()).toEqual([1, 2, 3]);
    }),
  );

  it(
    'throws when unset',
    withSavedEnv(() => {
      expect(() => loadPortalConfigTenantIds()).toThrow(/PORTAL_CONFIG_TENANT_IDS is required/);
    }),
  );

  it(
    'throws on a non-integer entry',
    withSavedEnv(() => {
      process.env.PORTAL_CONFIG_TENANT_IDS = '1,abc';
      expect(() => loadPortalConfigTenantIds()).toThrow(/Invalid PORTAL_CONFIG_TENANT_IDS entry/);
    }),
  );
});

// -------------------------------------------------------------------------------------------
// Mock portal — implements the real proto shape (implementation note 7 of this task's own file).
// -------------------------------------------------------------------------------------------

function protoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'campaign_config.proto');
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

function unimplemented(callback: grpc.sendUnaryData<unknown>): void {
  callback({ name: 'Unimplemented', message: 'not used', code: grpc.status.UNIMPLEMENTED });
}

function buildCampaign(overrides: Partial<CampaignConfigProto> = {}): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode: 'CAMP1',
    tenantId: 1,
    countryId: 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    budget: { amount: '1000.00', currency: 'USD' },
    maxParticipants: 100,
    merchants: [],
    trackers: [],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'REWARDS', 'CAPS'],
    sectionsOmitted: [],
    ...overrides,
  };
}

interface MockPortalHandlers {
  getCampaignConfig: jest.Mock;
  listActiveCampaigns: jest.Mock;
}

function buildHandlers(
  campaign: CampaignConfigProto,
  denyPermission: boolean,
): { impl: grpc.UntypedServiceImplementation; handlers: MockPortalHandlers } {
  const getCampaignConfig = jest.fn(
    (
      call: grpc.ServerUnaryCall<unknown, CampaignConfigProto>,
      callback: grpc.sendUnaryData<CampaignConfigProto>,
    ) => {
      if (denyPermission) {
        callback({
          name: 'PermissionDenied',
          message: 'grant not provisioned',
          code: grpc.status.PERMISSION_DENIED,
        });
        return;
      }
      callback(null, campaign);
    },
  );
  const listActiveCampaigns = jest.fn(
    (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<{ campaigns: CampaignConfigProto[] }>,
    ) => {
      if (denyPermission) {
        callback({
          name: 'PermissionDenied',
          message: 'grant not provisioned',
          code: grpc.status.PERMISSION_DENIED,
        });
        return;
      }
      callback(null, {
        campaigns: [campaign],
        servedAt: new Date().toISOString(),
        sectionsReturned: [],
        sectionsOmitted: [],
      } as never);
    },
  );

  const impl: grpc.UntypedServiceImplementation = {
    getCampaignConfig,
    listActiveCampaigns,
    watchCampaignConfig: (call: grpc.ServerWritableStream<unknown, unknown>) => {
      call.on('cancelled', () => call.end());
    },
    resolveRuleVersion: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
    resolveRewardVersion: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
    getBudgetStatus: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
  } as unknown as grpc.UntypedServiceImplementation;

  return { impl, handlers: { getCampaignConfig, listActiveCampaigns } };
}

function startMockServer(
  campaign: CampaignConfigProto,
  denyPermission = false,
): Promise<{ server: grpc.Server; port: number; handlers: MockPortalHandlers }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    const { impl, handlers } = buildHandlers(campaign, denyPermission);
    server.addService(loadServiceDefinition(), impl);
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port, handlers });
    });
  });
}

function stopMockServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}

describe('T-RR-022 — CampaignConfigClient, real mock portal', () => {
  let server: grpc.Server;
  let port: number;
  let handlers: MockPortalHandlers;
  let client: CampaignConfigClient;
  const campaign = buildCampaign();

  beforeEach(async () => {
    ({ server, port, handlers } = await startMockServer(campaign));
    client = new CampaignConfigClient({ host: '127.0.0.1', port, timeoutMs: 2_000 });
  });

  afterEach(async () => {
    await client.onModuleDestroy();
    await stopMockServer(server);
  });

  it('getCampaignConfig round-trips the real proto shape', async () => {
    const response = await client.getCampaignConfig(1, 'CAMP1');
    expect(response.campaignCode).toBe('CAMP1');
    expect(response.etag).toBe('etag-1');
  });

  it('listActiveCampaigns round-trips the real proto shape', async () => {
    const response = await client.listActiveCampaigns(1);
    expect(response.campaigns).toHaveLength(1);
    expect(response.campaigns[0].campaignCode).toBe('CAMP1');
  });

  // TC-7.
  it('TC-7: the outgoing sections list is exactly [BASIC, MERCHANTS, TRACKERS, REWARDS, CAPS] — never RULES', async () => {
    await client.getCampaignConfig(1, 'CAMP1');
    await client.listActiveCampaigns(1);

    const getRequest = handlers.getCampaignConfig.mock.calls[0][0].request as {
      sections: string[];
    };
    const listRequest = handlers.listActiveCampaigns.mock.calls[0][0].request as {
      sections: string[];
    };
    expect(getRequest.sections).toEqual([...CAMPAIGN_CONFIG_SECTIONS]);
    expect(listRequest.sections).toEqual([...CAMPAIGN_CONFIG_SECTIONS]);
    expect(getRequest.sections).not.toContain('RULES');
    expect(CAMPAIGN_CONFIG_SECTIONS).not.toContain('RULES');
  });
});

describe('T-RR-022 — CampaignConfigClient, PERMISSION_DENIED classification', () => {
  // TC-6.
  it('TC-6: a PERMISSION_DENIED response is classified as PortalGrantNotProvisionedError, not a generic error', async () => {
    const { server, port } = await startMockServer(buildCampaign(), true);
    const client = new CampaignConfigClient({ host: '127.0.0.1', port, timeoutMs: 2_000 });
    try {
      await expect(client.getCampaignConfig(1, 'CAMP1')).rejects.toBeInstanceOf(
        PortalGrantNotProvisionedError,
      );
      await expect(client.getCampaignConfig(1, 'CAMP1')).rejects.toThrow(/grpc_service_grants row/);
    } finally {
      await client.onModuleDestroy();
      await stopMockServer(server);
    }
  });

  it('a non-PERMISSION_DENIED failure (e.g. unreachable server) propagates unclassified', async () => {
    // Bind and immediately shut down — nothing listens on this port afterward.
    const { server, port } = await startMockServer(buildCampaign());
    await stopMockServer(server);

    const client = new CampaignConfigClient({ host: '127.0.0.1', port, timeoutMs: 500 });
    try {
      await expect(client.getCampaignConfig(1, 'CAMP1')).rejects.not.toBeInstanceOf(
        PortalGrantNotProvisionedError,
      );
    } finally {
      await client.onModuleDestroy();
    }
  });
});

/**
 * T-INT-012. `listActiveCampaigns`/`getCampaignConfig`'s new transport-resolution branching
 * (`callWithTransportFallback`), tested directly against a real `CampaignConfigClient` instance
 * with a fake `PortalConfigChannelResolverService` (constructor-injected, per that class's own
 * `@Optional()` params) and its own private `*ViaGrpc` methods stubbed via `jest.spyOn` — an
 * explicit direct port of RAP's own identical suite
 * (`realtime-activity-processing-service/test/modules/campaign-cache/campaign-config.client.spec.ts`,
 * T-INT-011 — confirmed by direct read before diverging in shape), avoiding a second mock gRPC
 * server here purely to prove branching order (the "real mock portal" describe block above already
 * proves the real wire-level round trip for both RPCs).
 *
 * `restClient`/`fakeResolver` are typed as narrow structural fakes (`Pick<...>`-shaped casts) —
 * same "test-only escape hatch, not `any`" precedent `promo-code-channel-resolver.service.spec.ts`'s
 * own header documents for its `FakePool`.
 */
describe('T-INT-012 — CampaignConfigClient transport fallback', () => {
  function buildClient(
    resolved:
      | {
          primaryChannel: 'REST' | 'GRPC';
          fallbackChannel: 'REST' | 'GRPC';
          restEnabled: boolean;
          grpcEnabled: boolean;
        }
      | Error,
    restImpl: { listActiveCampaigns?: jest.Mock; getCampaignConfig?: jest.Mock } = {},
  ): CampaignConfigClient {
    const fakeResolver = {
      resolve: jest.fn(async () => {
        if (resolved instanceof Error) throw resolved;
        return resolved;
      }),
    };
    const fakeRestClient = {
      listActiveCampaigns: restImpl.listActiveCampaigns ?? jest.fn(),
      getCampaignConfig: restImpl.getCampaignConfig ?? jest.fn(),
    };
    return new CampaignConfigClient(
      loadCampaignConfigClientOptions(),
      fakeRestClient as unknown as import('@/modules/processing/portal-config-rest.client').PortalConfigRestClient,
      fakeResolver as unknown as import('@/modules/processing/portal-config-channel-resolver.service').PortalConfigChannelResolverService,
    );
  }

  const listResult = { campaigns: [], servedAt: 'now', sectionsReturned: [], sectionsOmitted: [] };

  it('TC-2: REST primary, REST reachable -> real data via REST, zero gRPC calls made', async () => {
    const client = buildClient(
      { primaryChannel: 'REST', fallbackChannel: 'GRPC', restEnabled: true, grpcEnabled: true },
      { listActiveCampaigns: jest.fn().mockResolvedValue(listResult) },
    );
    const grpcSpy = jest.spyOn(client as never, 'listActiveCampaignsViaGrpc');

    const result = await client.listActiveCampaigns(1);

    expect(result).toBe(listResult);
    expect(grpcSpy).not.toHaveBeenCalled();
  });

  it('TC-3: REST primary, REST unreachable, GRPC fallback configured and reachable -> REST attempted, fails, gRPC succeeds', async () => {
    const restCall = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = buildClient(
      { primaryChannel: 'REST', fallbackChannel: 'GRPC', restEnabled: true, grpcEnabled: true },
      { listActiveCampaigns: restCall },
    );
    const grpcSpy = jest
      .spyOn(client as never, 'listActiveCampaignsViaGrpc')
      .mockResolvedValue(listResult as never);

    const result = await client.listActiveCampaigns(1);

    expect(restCall).toHaveBeenCalledTimes(1);
    expect(grpcSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(listResult);
  });

  it('TC-4: primary flipped to GRPC (as set-transport-primary.js would do) -> GRPC used as primary, REST never attempted', async () => {
    const client = buildClient(
      { primaryChannel: 'GRPC', fallbackChannel: 'REST', restEnabled: true, grpcEnabled: true },
      { listActiveCampaigns: jest.fn() },
    );
    const grpcSpy = jest
      .spyOn(client as never, 'listActiveCampaignsViaGrpc')
      .mockResolvedValue(listResult as never);

    const result = await client.listActiveCampaigns(1);

    expect(grpcSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(listResult);
  });

  it('TC-5 (negative): both REST and GRPC fail -> rejects, same failure contract as today', async () => {
    const client = buildClient(
      { primaryChannel: 'REST', fallbackChannel: 'GRPC', restEnabled: true, grpcEnabled: true },
      { listActiveCampaigns: jest.fn().mockRejectedValue(new Error('rest down')) },
    );
    jest
      .spyOn(client as never, 'listActiveCampaignsViaGrpc')
      .mockRejectedValue(new Error('grpc down') as never);

    await expect(client.listActiveCampaigns(1)).rejects.toThrow('grpc down');
  });

  it('a disabled primary channel is skipped entirely in favour of the fallback', async () => {
    const restCall = jest.fn();
    const client = buildClient(
      { primaryChannel: 'REST', fallbackChannel: 'GRPC', restEnabled: false, grpcEnabled: true },
      { listActiveCampaigns: restCall },
    );
    const grpcSpy = jest
      .spyOn(client as never, 'listActiveCampaignsViaGrpc')
      .mockResolvedValue(listResult as never);

    await client.listActiveCampaigns(1);

    expect(restCall).not.toHaveBeenCalled();
    expect(grpcSpy).toHaveBeenCalledTimes(1);
  });

  it('resolver failure (e.g. DB unreachable / migration 025 not yet applied) degrades to the pre-T-INT-012 gRPC-only call', async () => {
    const client = buildClient(new Error('relation "portal_config_channel_config" does not exist'));
    const grpcSpy = jest
      .spyOn(client as never, 'listActiveCampaignsViaGrpc')
      .mockResolvedValue(listResult as never);

    const result = await client.listActiveCampaigns(1);

    expect(grpcSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(listResult);
  });

  it('getCampaignConfig follows the identical resolution contract as listActiveCampaigns', async () => {
    const campaignResult = { campaignCode: 'CMP-1' } as never;
    const client = buildClient(
      { primaryChannel: 'REST', fallbackChannel: 'GRPC', restEnabled: true, grpcEnabled: true },
      { getCampaignConfig: jest.fn().mockResolvedValue(campaignResult) },
    );
    const grpcSpy = jest.spyOn(client as never, 'getCampaignConfigViaGrpc');

    const result = await client.getCampaignConfig(1, 'CMP-1');

    expect(result).toBe(campaignResult);
    expect(grpcSpy).not.toHaveBeenCalled();
  });

  it(
    'TC-6 remains intact through the transport wrapper: a PERMISSION_DENIED from the gRPC ' +
      'fallback still classifies as PortalGrantNotProvisionedError, not a generic rejection',
    async () => {
      // `restEnabled: false` so only GRPC is ever attempted — this test is about
      // `PortalGrantNotProvisionedError` surviving the wrapper unclassified-to-something-else, not
      // about fallback ordering (already covered by TC-2..TC-5 above); a REST fallback attempt
      // succeeding trivially against an unmocked fake would otherwise mask the very error this
      // test exists to prove is preserved.
      const client = buildClient(
        { primaryChannel: 'GRPC', fallbackChannel: 'REST', restEnabled: false, grpcEnabled: true },
        {},
      );
      const deniedError = Object.assign(new Error('denied'), {
        code: 7, // grpc.status.PERMISSION_DENIED
      });
      jest
        .spyOn(client as never, 'getCampaignConfigViaGrpc')
        .mockRejectedValue(
          new PortalGrantNotProvisionedError('GetCampaignConfig', 1, deniedError as never) as never,
        );

      await expect(client.getCampaignConfig(1, 'CAMP1')).rejects.toBeInstanceOf(
        PortalGrantNotProvisionedError,
      );
    },
  );
});
