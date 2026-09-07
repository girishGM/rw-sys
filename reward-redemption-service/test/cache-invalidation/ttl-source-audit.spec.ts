/**
 * T-RR-044 — TTL-sourcing audit for all five caches `06-CACHING-AND-TENANT-CONFIG.md` §1/§2 lists
 * (implementation note 3, TC-7). Every cache's expiry must trace back to its own
 * `cache.ttl.<name>.seconds` `service_config` read — never a hardcoded number anywhere in that
 * path — with exactly one documented exception: the `serviceConfig` cache's own bootstrap-only
 * default (`SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS`) for resolving its own TTL key, already
 * thoroughly proven narrow by T-RR-007's own `test/tenant-schema-cache/service-config.cache.spec.ts`
 * ("caches every OTHER key using the real resolved TTL value" / "caches its OWN TTL key using the
 * compiled-in bootstrap default, never a value resolved from itself") — not re-derived here.
 *
 * **Finding, filed as T-RR-068 (`agent-rr-foundation`).** This audit originally found a SECOND,
 * undocumented hardcoded TTL value — `CampaignConfigCache`'s own `DEFAULT_CAMPAIGN_CONFIG_TTL_MS`
 * fallback — which was not a rare defensive path but, in every real/deployed environment at the
 * time, the *only* value this cache's TTL ever actually took, because no `service_config` seed row
 * existed for `cache.ttl.campaignConfig.seconds` at any scope. `src/database/migrations/**` is
 * outside this task's own file scope (R3), so this task filed T-RR-068 rather than adding the row
 * itself; `016_seed_campaign_config_ttl.ts` (T-RR-068's own fix, landed while this task was still
 * in flight) added the missing `GLOBAL` row, after which `CampaignConfigCache.ttlMs()`'s own
 * try/catch fallback becomes the same kind of narrow, genuinely-defensive-only guard
 * `ReconciliationPollerService.resolveIntervalMs()`'s own `DEFAULT_RECONCILIATION_INTERVAL_MS`
 * fallback already is — exercised only if a scope/environment is genuinely unseeded, not on every
 * real call. The "campaignConfig" describe block below tests both the now-fixed, DB-sourced steady
 * state and that defensive fallback's own narrow scope (via a fake, since forcing the real seed row
 * to disappear again would mutate shared, cross-file `service_config` state — the same reason
 * `reconciliation-poller-safety-net.spec.ts`'s own header gives for faking rather than mutating
 * those rows).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  CACHE_TTL_CONFIG_KEYS,
  RECONCILIATION_POLL_INTERVAL_CONFIG_KEY,
} from '@/modules/tenant-schema-cache/cache-ttl-config-keys';
import {
  SERVICE_CONFIG_TTL_KEY,
  ServiceConfigCache,
} from '@/modules/tenant-schema-cache/service-config.cache';
import { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';
import { TenantSchemaConfigRepository } from '@/modules/tenant-schema-cache/tenant-schema-config.repository';
import { ExternalRewardSystemConfigCache } from '@/modules/tenant-schema-cache/external-reward-system-config.cache';
import { ExternalRewardSystemConfigRepository } from '@/modules/tenant-schema-cache/external-reward-system-config.repository';
import { DispatchChannelConfigCache } from '@/modules/tenant-schema-cache/dispatch-channel-config.cache';
import { DispatchChannelConfigRepository } from '@/modules/tenant-schema-cache/dispatch-channel-config.repository';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import {
  CAMPAIGN_CONFIG_TTL_KEY,
  CampaignConfigCache,
  DEFAULT_CAMPAIGN_CONFIG_TTL_MS,
} from '@/modules/processing/campaign-config.cache';
import type {
  CampaignConfigClient,
  CampaignConfigProto,
} from '@/modules/processing/campaign-config.client';

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');

function readFile(relativeToSrc: string): string {
  return readFileSync(path.join(SRC_ROOT, relativeToSrc), 'utf8');
}

/** Every numeric-literal `_MS`/`_SECONDS`-shaped constant declaration found across the five
 * caches' own files, keyed by the file it lives in — this audit's own "allowlist" of exactly what
 * is permitted to be a hardcoded number in this path, and why. */
const CACHE_FILES: ReadonlyArray<{ file: string; cacheName: string }> = [
  {
    file: 'modules/tenant-schema-cache/tenant-schema-config.cache.ts',
    cacheName: 'tenantSchemaConfig',
  },
  {
    file: 'modules/tenant-schema-cache/external-reward-system-config.cache.ts',
    cacheName: 'externalRewardSystemConfig',
  },
  {
    file: 'modules/tenant-schema-cache/dispatch-channel-config.cache.ts',
    cacheName: 'dispatchChannelConfig',
  },
  { file: 'modules/tenant-schema-cache/service-config.cache.ts', cacheName: 'serviceConfig' },
  { file: 'modules/processing/campaign-config.cache.ts', cacheName: 'campaignConfig' },
];

describe('T-RR-044 — TC-7: static audit — every cache file, grepped for a hardcoded TTL literal', () => {
  it('tenantSchemaConfig / externalRewardSystemConfig / dispatchChannelConfig own cache files declare no numeric TTL constant at all — every TTL comes from CACHE_TTL_CONFIG_KEYS + ServiceConfigCache.resolve()', () => {
    for (const { file, cacheName } of CACHE_FILES.slice(0, 3)) {
      const source = readFile(file);
      // No cache-scoped numeric millisecond/second constant of its own — the only way this cache
      // learns a TTL is via `serviceConfigCache.resolve(CACHE_TTL_CONFIG_KEYS.<name>, 'int', ...)`.
      expect(source).not.toMatch(/const\s+[A-Z_]*TTL[A-Z_]*\s*=\s*[0-9]/);
      expect(source).toContain(`CACHE_TTL_CONFIG_KEYS.${cacheName}`);
    }
  });

  it("serviceConfig's own cache file declares exactly one numeric TTL constant — SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS — and it is used only for caching that cache's own TTL key, never any other key", () => {
    const source = readFile('modules/tenant-schema-cache/service-config.cache.ts');
    const ttlConstantDeclarations = source.match(/const\s+[A-Z_]*TTL[A-Z_]*\s*=\s*[0-9_]+/g) ?? [];
    expect(ttlConstantDeclarations).toHaveLength(1);
    expect(ttlConstantDeclarations[0]).toContain('SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS');
    // Applied only inside the `isServiceConfigTtlKey(configKey)` branch (this file's own header
    // explains why: resolving that one key's own cache duration from itself would be circular).
    expect(source).toMatch(
      /isServiceConfigTtlKey\(configKey\)\s*\n?\s*\?\s*SERVICE_CONFIG_CACHE_BOOTSTRAP_TTL_MS/,
    );
  });

  it("campaignConfig's own cache file declares a second numeric TTL constant, DEFAULT_CAMPAIGN_CONFIG_TTL_MS — resolved by T-RR-068's own 016_seed_campaign_config_ttl.ts into the same kind of narrow, genuinely-defensive-only fallback ReconciliationPollerService's own DEFAULT_RECONCILIATION_INTERVAL_MS already is, never the sole active path", () => {
    const source = readFile('modules/processing/campaign-config.cache.ts');
    expect(source).toContain('DEFAULT_CAMPAIGN_CONFIG_TTL_MS');
    // It always attempts the real service_config-sourced path first — the fallback is a `catch`,
    // not a substitute for the real read.
    expect(source).toMatch(/serviceConfigCache\.resolve\(CAMPAIGN_CONFIG_TTL_KEY/);
  });
});

describe('T-RR-044 — TC-7: dynamic audit (real Postgres) — all five caches genuinely resolve from service_config', () => {
  let db: Sequelize;
  let serviceConfigCache: ServiceConfigCache;
  // Every directly-`new`-constructed repository this describe block builds owns its own real
  // `pg.Pool` (never through Nest DI, so nothing closes it automatically) — collected here and
  // closed in `afterAll` so this file doesn't leak open Postgres connections across the test run.
  const openRepositories: Array<{ onModuleDestroy: () => Promise<void> }> = [];

  beforeAll(async () => {
    db = createMigrationConnection();
    await db.authenticate();
    const serviceConfigRepository = new ServiceConfigRepository(realDbConfigService());
    openRepositories.push(serviceConfigRepository);
    const resolver = new ServiceConfigResolverService(serviceConfigRepository);
    serviceConfigCache = new ServiceConfigCache(resolver, serviceConfigRepository);
  });

  afterAll(async () => {
    await db.close();
    await Promise.all(openRepositories.map((repository) => repository.onModuleDestroy()));
  });

  async function seededGlobalValue(configKey: string): Promise<number> {
    const rows = await db.query<{ config_value: string }>(
      `SELECT config_value FROM reward_redemption.service_config
       WHERE config_key = :configKey AND scope_level = 'GLOBAL' AND scope_ref IS NULL`,
      { type: QueryTypes.SELECT, replacements: { configKey } },
    );
    expect(rows).toHaveLength(1); // sanity: the row this whole audit depends on actually exists
    return Number(rows[0].config_value);
  }

  it.each([
    ['tenantSchemaConfig', CACHE_TTL_CONFIG_KEYS.tenantSchemaConfig],
    ['externalRewardSystemConfig', CACHE_TTL_CONFIG_KEYS.externalRewardSystemConfig],
    ['dispatchChannelConfig', CACHE_TTL_CONFIG_KEYS.dispatchChannelConfig],
    ['serviceConfig', SERVICE_CONFIG_TTL_KEY],
    // T-RR-068's own fix (`016_seed_campaign_config_ttl.ts`) added this row — see the dedicated
    // "campaignConfig" describe block below for the fallback-path coverage this one row can't
    // exercise on its own.
    ['campaignConfig', CAMPAIGN_CONFIG_TTL_KEY],
  ])(
    "%s's own TTL, resolved through the real ServiceConfigCache against the real DB, equals exactly what the service_config row itself currently holds",
    async (_name, configKey) => {
      const [resolved, stored] = await Promise.all([
        serviceConfigCache.resolve(configKey, 'int', {}),
        seededGlobalValue(configKey),
      ]);
      // Asserts equality with a freshly-queried DB value, not a magic literal this test itself
      // hardcodes — if the seeded default in `015_seed_service_config_defaults.ts` ever changes,
      // this test tracks it rather than silently drifting into a false pass.
      expect(resolved).toBe(stored);
    },
  );

  it('each of the three DB-backed caches (tenantSchemaConfig/externalRewardSystemConfig/dispatchChannelConfig) genuinely asks ServiceConfigCache for its own named TTL key on a cache miss — not a substitute/hardcoded key', async () => {
    const resolveSpy = jest.spyOn(serviceConfigCache, 'resolve');

    const tenantSchemaConfigRepository = new TenantSchemaConfigRepository(realDbConfigService());
    openRepositories.push(tenantSchemaConfigRepository);
    const tenantSchemaConfigCache = new TenantSchemaConfigCache(
      tenantSchemaConfigRepository,
      serviceConfigCache,
    );
    await tenantSchemaConfigCache.get({ tenantId: -999_999, environment: 'nonexistent-env' });
    expect(resolveSpy).toHaveBeenCalledWith(CACHE_TTL_CONFIG_KEYS.tenantSchemaConfig, 'int', {});
    resolveSpy.mockClear();

    const externalRewardSystemConfigRepository = new ExternalRewardSystemConfigRepository(
      realDbConfigService(),
    );
    openRepositories.push(externalRewardSystemConfigRepository);
    const externalRewardSystemConfigCache = new ExternalRewardSystemConfigCache(
      externalRewardSystemConfigRepository,
      serviceConfigCache,
    );
    await externalRewardSystemConfigCache.get({ systemCode: 'NONEXISTENT-SYSTEM-CODE' });
    expect(resolveSpy).toHaveBeenCalledWith(
      CACHE_TTL_CONFIG_KEYS.externalRewardSystemConfig,
      'int',
      {},
    );
    resolveSpy.mockClear();

    const dispatchChannelConfigRepository = new DispatchChannelConfigRepository(
      realDbConfigService(),
    );
    openRepositories.push(dispatchChannelConfigRepository);
    const dispatchChannelConfigCache = new DispatchChannelConfigCache(
      dispatchChannelConfigRepository,
      serviceConfigCache,
    );
    await dispatchChannelConfigCache.get({
      scopeLevel: 'REWARD',
      scopeRefCode: 'NONEXISTENT-REWARD-CODE',
      tenantId: -999_999,
    });
    expect(resolveSpy).toHaveBeenCalledWith(CACHE_TTL_CONFIG_KEYS.dispatchChannelConfig, 'int', {});

    resolveSpy.mockRestore();
  });

  it('sanity: RECONCILIATION_POLL_INTERVAL_CONFIG_KEY (a distinct, §4-owned key, not one of the five §2 TTLs) is also genuinely DB-sourced, matching the same discipline', async () => {
    const resolved = await serviceConfigCache.resolve(
      RECONCILIATION_POLL_INTERVAL_CONFIG_KEY,
      'int',
      {},
    );
    const stored = await seededGlobalValue(RECONCILIATION_POLL_INTERVAL_CONFIG_KEY);
    expect(resolved).toBe(stored);
  });
});

describe('T-RR-044 — TC-7: campaignConfig — CampaignConfigCache itself asks for the real key, and its own defensive fallback stays narrow (T-RR-068)', () => {
  let db: Sequelize;
  let serviceConfigCache: ServiceConfigCache;
  let serviceConfigRepository: ServiceConfigRepository;

  beforeAll(async () => {
    db = createMigrationConnection();
    await db.authenticate();
    serviceConfigRepository = new ServiceConfigRepository(realDbConfigService());
    const resolver = new ServiceConfigResolverService(serviceConfigRepository);
    serviceConfigCache = new ServiceConfigCache(resolver, serviceConfigRepository);
  });

  afterAll(async () => {
    await db.close();
    await serviceConfigRepository.onModuleDestroy();
  });

  function buildStubClient(): CampaignConfigClient {
    const config: CampaignConfigProto = {
      campaignCode: 'CAMP-AUDIT',
      tenantId: 1,
    } as unknown as CampaignConfigProto;
    return {
      getCampaignConfig: jest.fn().mockResolvedValue(config),
      listActiveCampaigns: jest.fn().mockResolvedValue({ campaigns: [] }),
    } as unknown as CampaignConfigClient;
  }

  it('CampaignConfigCache genuinely asks the real, DB-backed ServiceConfigCache for CAMPAIGN_CONFIG_TTL_KEY on a cache miss, against the real Postgres row T-RR-068 added', async () => {
    const resolveSpy = jest.spyOn(serviceConfigCache, 'resolve');
    const cache = new CampaignConfigCache(buildStubClient(), serviceConfigCache, [1]);

    await cache.get(1, 'CAMP-AUDIT');

    expect(resolveSpy).toHaveBeenCalledWith(CAMPAIGN_CONFIG_TTL_KEY, 'int', {});

    // Resolves now (T-RR-068's own seed row), rather than throwing `ServiceConfigNotFoundError` —
    // and equals exactly what the row itself currently holds, not a literal this test hardcodes.
    const rows = await db.query<{ config_value: string }>(
      `SELECT config_value FROM reward_redemption.service_config
       WHERE config_key = :configKey AND scope_level = 'GLOBAL' AND scope_ref IS NULL`,
      { type: QueryTypes.SELECT, replacements: { configKey: CAMPAIGN_CONFIG_TTL_KEY } },
    );
    expect(rows).toHaveLength(1);
    await expect(serviceConfigCache.resolve(CAMPAIGN_CONFIG_TTL_KEY, 'int', {})).resolves.toBe(
      Number(rows[0].config_value),
    );

    resolveSpy.mockRestore();
  });

  it("CampaignConfigCache's own DEFAULT_CAMPAIGN_CONFIG_TTL_MS fallback is exercised only when resolution genuinely fails — proven with a fake resolver so this doesn't depend on mutating the real, shared service_config row T-RR-068 added", async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    const client = buildStubClient();
    // A fake `ServiceConfigCache` whose `resolve()` always rejects — simulating a genuinely
    // unseeded scope/environment, the one case this fallback exists for (mirrors
    // `ReconciliationPollerService.resolveIntervalMs()`'s own identical fallback-on-rejection
    // shape, already accepted for the same reason in that class).
    const alwaysRejectingServiceConfigCache = {
      resolve: jest
        .fn()
        .mockRejectedValue(new Error('cache.ttl.campaignConfig.seconds not seeded')),
    };
    const cache = new CampaignConfigCache(
      client,
      alwaysRejectingServiceConfigCache as unknown as ServiceConfigCache,
      [1],
    );

    await cache.get(1, 'CAMP-AUDIT');
    (client.getCampaignConfig as jest.Mock).mockClear();

    // Just under the hardcoded default — still a hit.
    nowSpy.mockReturnValue(DEFAULT_CAMPAIGN_CONFIG_TTL_MS - 1_000);
    await cache.get(1, 'CAMP-AUDIT');
    expect(client.getCampaignConfig).not.toHaveBeenCalled();

    // Just past it — now a miss, proving DEFAULT_CAMPAIGN_CONFIG_TTL_MS (not some other duration)
    // is exactly what governs this entry's lifetime when — and only when — resolution fails.
    nowSpy.mockReturnValue(DEFAULT_CAMPAIGN_CONFIG_TTL_MS + 1_000);
    await cache.get(1, 'CAMP-AUDIT');
    expect(client.getCampaignConfig).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });
});

// Shared real-DB `ConfigService` stand-in — same pattern already established by
// `test/processing/claim-worker.service.spec.ts` (T-RR-020) for constructing a real repository
// directly against the real local Postgres without going through Nest DI.
function realDbConfigService(): import('@nestjs/config').ConfigService<
  import('@/config/config.schema').Config,
  true
> {
  const values: Record<string, unknown> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
  };
  return {
    get: (key: string) => values[key],
  } as unknown as import('@nestjs/config').ConfigService<
    import('@/config/config.schema').Config,
    true
  >;
}
