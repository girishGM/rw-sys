/**
 * T-RR-068 regression suite. `016_seed_campaign_config_ttl.ts` seeds the one `GLOBAL`
 * `service_config` row `015_seed_service_config_defaults.ts` never added:
 * `cache.ttl.campaignConfig.seconds` — the fifth cache `06-CACHING-AND-TENANT-CONFIG.md` §1/§2
 * lists. Before this migration, `SELECT config_key FROM reward_redemption.service_config WHERE
 * config_key = 'cache.ttl.campaignConfig.seconds'` returned zero rows on a freshly migrated dev DB
 * (confirmed by direct reproduction against the real local Postgres — see this task's own
 * completion report for the exact command and output), so
 * `CampaignConfigCache.ttlMs()`'s (`src/modules/processing/campaign-config.cache.ts`, outside this
 * task's own file scope, R3 — not imported here) call to
 * `ServiceConfigCache.resolve('cache.ttl.campaignConfig.seconds', 'int', {})` always threw
 * `ServiceConfigNotFoundError`, so its own compiled-in `DEFAULT_CAMPAIGN_CONFIG_TTL_MS` (300_000ms)
 * fallback was the only value ever actually used in any real/deployed environment.
 *
 * Same two-level shape `service-config-defaults-seed.migration.spec.ts` (T-RR-051) already
 * established, and same real-Postgres, real-`rr_app`-role convention as every other
 * `test/database/*.migration.spec.ts` suite — no mock, no in-memory DB:
 *   1. The raw row shape (TC-1/TC-2) — a DB-level assertion independent of any application code.
 *   2. The real `ServiceConfigCache`/`ServiceConfigResolverService`/`ServiceConfigRepository` stack
 *      (T-RR-006/T-RR-007's own classes, this task's file scope), resolving the exact
 *      `(key, 'int', {})` call shape `CampaignConfigCache.ttlMs()` itself makes (TC-3) — the actual
 *      observable property that matters: that this key now resolves through
 *      `ServiceConfigCache.resolve()` at all, not just that a row with this key exists.
 *
 * TC-3 is the one proven red on the unfixed code: with migration 016 rolled back (`npm run
 * db:rollback`), this exact assertion throws `ServiceConfigNotFoundError` — see this task's own
 * completion report for the literal command run and output observed.
 */
import 'reflect-metadata';
import type { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';
import type { Config } from '@/config/config.schema';

/** `06-CACHING-AND-TENANT-CONFIG.md` §2's own key-naming table — literal here (not imported from
 * `campaign-config.cache.ts`'s own `CAMPAIGN_CONFIG_TTL_KEY`) deliberately: that module is
 * `src/modules/processing/**`, outside this task's file scope (R3), and this suite's own point is
 * to prove the DB-side fix independent of that module's own code. */
const CAMPAIGN_CONFIG_TTL_CONFIG_KEY = 'cache.ttl.campaignConfig.seconds';
const CAMPAIGN_CONFIG_TTL_DEFAULT_SECONDS = 300;

/** Same substitution idiom as `service-config-defaults-seed.migration.spec.ts`'s own
 * `realDbConfigService()`. */
function realDbConfigService(): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
  } as Partial<Config>;
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

describe('T-RR-068 — cache.ttl.campaignConfig.seconds GLOBAL seed row', () => {
  let migrationDb: Sequelize;
  let repository: ServiceConfigRepository;
  let resolver: ServiceConfigResolverService;
  let serviceConfigCache: ServiceConfigCache;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    repository = new ServiceConfigRepository(realDbConfigService());
    resolver = new ServiceConfigResolverService(repository);
    serviceConfigCache = new ServiceConfigCache(resolver, repository);
  });

  afterAll(async () => {
    await migrationDb.close();
    await repository.onModuleDestroy();
  });

  // TC-1: reproduces the exact defect T-RR-044 reported — before 016 existed/was applied, this
  // query returned zero rows.
  it('TC-1/TC-2: exactly one GLOBAL row exists for "cache.ttl.campaignConfig.seconds", value_type=int, scope_ref NULL, value 300', async () => {
    const rows = await migrationDb.query<{
      config_value: string;
      value_type: string;
      scope_ref: string | null;
    }>(
      `SELECT config_value, value_type, scope_ref FROM reward_redemption.service_config
       WHERE config_key = :key AND scope_level = 'GLOBAL'`,
      { type: QueryTypes.SELECT, replacements: { key: CAMPAIGN_CONFIG_TTL_CONFIG_KEY } },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].scope_ref).toBeNull();
    expect(rows[0].value_type).toBe('int');
    expect(Number(rows[0].config_value)).toBe(CAMPAIGN_CONFIG_TTL_DEFAULT_SECONDS);
  });

  // TC-3 (the one that matters): the real ServiceConfigCache, unmocked, resolving the exact call
  // shape CampaignConfigCache.ttlMs() itself makes (`resolve(key, 'int', {})`) must now succeed
  // rather than throw ServiceConfigNotFoundError — proven red on the unfixed code by rolling back
  // migration 016 and re-running this exact assertion (see this task's completion report).
  it('TC-3: ServiceConfigCache.resolve("cache.ttl.campaignConfig.seconds", "int", {}) succeeds and returns the seeded value', async () => {
    await expect(
      serviceConfigCache.resolve(CAMPAIGN_CONFIG_TTL_CONFIG_KEY, 'int', {}),
    ).resolves.toBe(CAMPAIGN_CONFIG_TTL_DEFAULT_SECONDS);
  });

  // TC-4: adjacent behaviour that must not change — an unrelated, genuinely unconfigured key still
  // throws exactly as before; this migration must not have introduced some blanket fallback, and
  // the pre-existing `cache.ttl.*` seed rows from 015 are untouched.
  it('TC-4: a genuinely unconfigured key still throws ServiceConfigNotFoundError', async () => {
    await expect(resolver.resolve('t-rr-068.never.seeded.knob', 'int')).rejects.toThrow(
      'Unconfigured service_config key',
    );
  });

  it("TC-4 (continued): the other four caches' own 015-seeded GLOBAL TTL rows are unaffected", async () => {
    const rows = await migrationDb.query<{ config_key: string; config_value: string }>(
      `SELECT config_key, config_value FROM reward_redemption.service_config
       WHERE config_key IN (:keys) AND scope_level = 'GLOBAL' AND scope_ref IS NULL`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          keys: [
            'cache.ttl.serviceConfig.seconds',
            'cache.ttl.tenantSchemaConfig.seconds',
            'cache.ttl.externalRewardSystemConfig.seconds',
            'cache.ttl.dispatchChannelConfig.seconds',
          ],
        },
      },
    );

    expect(rows).toHaveLength(4);
  });

  // TC-4 (continued): no non-GLOBAL row exists for this key either — a narrow, auditable change
  // only, same discipline 015's own suite asserts for its seven keys.
  it('TC-4 (continued): no non-GLOBAL row exists for cache.ttl.campaignConfig.seconds', async () => {
    const rows = await migrationDb.query<{ config_key: string }>(
      `SELECT config_key FROM reward_redemption.service_config
       WHERE config_key = :key AND scope_level != 'GLOBAL'`,
      { type: QueryTypes.SELECT, replacements: { key: CAMPAIGN_CONFIG_TTL_CONFIG_KEY } },
    );

    expect(rows).toHaveLength(0);
  });
});
