/**
 * T-RAP-010. Pure, synchronous unit tests for `loadCampaignConfigClientOptions` — no network, no
 * DB. The real wire-level round trip against a live proto-shaped server is exercised in
 * `campaign-config-cache.e2e-spec.ts` (TC-1..3), which already stands up a mock portal for that
 * purpose — duplicating a second mock server here would just be the same coverage twice.
 *
 * **T-INT-011** added a second describe block below (`CampaignConfigClient transport fallback`)
 * covering the new REST/gRPC resolution branching `callWithTransportFallback` adds to
 * `listActiveCampaigns`/`getCampaignConfig` — still no real network or DB, since the resolver and
 * REST client are both constructor-injected fakes there.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CampaignConfigClient,
  DEFAULT_PORTAL_GRPC_PORT,
  DEFAULT_PORTAL_GRPC_TIMEOUT_MS,
  loadCampaignConfigClientOptions,
} from '@/modules/campaign-cache/campaign-config.client';

const ENV_KEYS = [
  'PORTAL_GRPC_HOST',
  'PORTAL_GRPC_PORT',
  'PORTAL_GRPC_TIMEOUT_MS',
  'PORTAL_GRPC_TLS_CA_PATH',
  'PORTAL_GRPC_TLS_CERT_PATH',
  'PORTAL_GRPC_TLS_KEY_PATH',
] as const;

describe('loadCampaignConfigClientOptions', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('defaults host/port/timeout when nothing is configured, and no TLS material', () => {
    const options = loadCampaignConfigClientOptions();
    expect(options).toEqual({
      host: 'localhost',
      port: DEFAULT_PORTAL_GRPC_PORT,
      timeoutMs: DEFAULT_PORTAL_GRPC_TIMEOUT_MS,
    });
  });

  it('reads a custom host/port/timeout from the environment', () => {
    process.env.PORTAL_GRPC_HOST = 'portal.internal';
    process.env.PORTAL_GRPC_PORT = '60123';
    process.env.PORTAL_GRPC_TIMEOUT_MS = '9000';

    const options = loadCampaignConfigClientOptions();
    expect(options.host).toBe('portal.internal');
    expect(options.port).toBe(60123);
    expect(options.timeoutMs).toBe(9000);
  });

  it('rejects a non-numeric PORTAL_GRPC_PORT', () => {
    process.env.PORTAL_GRPC_PORT = 'not-a-port';
    expect(() => loadCampaignConfigClientOptions()).toThrow(/PORTAL_GRPC_PORT/);
  });

  it('rejects a zero/negative PORTAL_GRPC_TIMEOUT_MS', () => {
    process.env.PORTAL_GRPC_TIMEOUT_MS = '0';
    expect(() => loadCampaignConfigClientOptions()).toThrow(/PORTAL_GRPC_TIMEOUT_MS/);
  });

  describe('TLS material', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'rap-grpc-client-tls-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a partial TLS configuration (only some of the three paths set)', () => {
      const caPath = join(dir, 'ca.pem');
      writeFileSync(caPath, 'fake-ca');
      process.env.PORTAL_GRPC_TLS_CA_PATH = caPath;
      // cert/key paths deliberately left unset.

      expect(() => loadCampaignConfigClientOptions()).toThrow(
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

      const options = loadCampaignConfigClientOptions();
      expect(options.tls?.rootCerts.toString()).toBe('fake-ca');
      expect(options.tls?.clientCert.toString()).toBe('fake-cert');
      expect(options.tls?.clientKey.toString()).toBe('fake-key');
    });
  });
});

/**
 * T-INT-011. `listActiveCampaigns`/`getCampaignConfig`'s new transport-resolution branching
 * (`callWithTransportFallback`), tested directly against a real `CampaignConfigClient` instance
 * with a fake `PortalConfigChannelResolverService` (constructor-injected, per that class's own
 * `@Optional()` params) and its own private `*ViaGrpc` methods stubbed via `jest.spyOn` — this
 * avoids standing up a second mock gRPC server here purely to prove branching order, which
 * `campaign-config-cache.e2e-spec.ts` (TC-1..3) already does for the real wire-level round trip
 * (and, since migration `016`'s seeded `GLOBAL` row defaults `primary_channel='REST'`, that e2e
 * test's own unconfigured `PORTAL_REST_API_TOKEN` now doubles as a real, unmodified TC-3
 * regression: REST is attempted first, fails, and the mock gRPC server it already stands up serves
 * the fallback — see this task's own completion report).
 *
 * `restClient` is typed as a narrow structural fake (`Pick<PortalConfigRestClient, ...>` cast) —
 * same "test-only escape hatch, not `any`" precedent `promo-code-channel-resolver.service.spec.ts`'s
 * own header documents for its `FakePool`.
 */
describe('T-INT-011 — CampaignConfigClient transport fallback', () => {
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
      fakeRestClient as unknown as import('@/modules/campaign-cache/portal-config-rest.client').PortalConfigRestClient,
      fakeResolver as unknown as import('@/modules/campaign-cache/portal-config-channel-resolver.service').PortalConfigChannelResolverService,
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

  it('resolver failure (e.g. DB unreachable / migration 016 not yet applied) degrades to the pre-T-INT-011 gRPC-only call', async () => {
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
});
