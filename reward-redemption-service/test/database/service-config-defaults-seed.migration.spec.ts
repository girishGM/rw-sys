/**
 * T-RR-051 regression suite. `015_seed_service_config_defaults.ts` seeds exactly one `GLOBAL`
 * `service_config` row per key this service's code actually resolves through
 * `ServiceConfigResolverService.resolve()` as of this writing. Before this migration existed, the
 * table was empty after a full `db:migrate` (confirmed by direct reproduction: `SELECT count(*)
 * FROM reward_redemption.service_config` returned `0` rows on a freshly migrated dev DB), so every
 * one of these keys threw `ServiceConfigNotFoundError` on first real (non-test-seeded) resolution —
 * `CompletionSweepService`'s own poll loop being the concrete case `T-RR-021` reported.
 *
 * This suite exercises both levels deliberately, not just one:
 *   1. The raw row shape (TC-1/TC-2) — a DB-level assertion independent of any application code,
 *      so a future migration edit that accidentally drops a row is caught even if the resolver
 *      module itself is never touched.
 *   2. The real `ServiceConfigResolverService`/`ServiceConfigRepository` pair, unmodified, resolving
 *      every key with an empty scope context (TC-3) — the actual observable property every caller
 *      in this codebase depends on (`06-CACHING-AND-TENANT-CONFIG.md` §1/§2,
 *      `05-PROCESSING-PIPELINE.md` §2), not just "a row with this key exists".
 *
 * Same real-Postgres, real-`rr_app`-role convention as `service-config.repository.spec.ts`
 * (T-RR-006) and every other `test/database/*.migration.spec.ts` suite — no mock, no in-memory DB.
 */
import 'reflect-metadata';
import type { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import type { Config } from '@/config/config.schema';

/** Every `config_key` this task confirmed (by exhaustive grep of every `.resolve(` call site in
 * `src/`, none of it mocked) is actually read via `ServiceConfigResolverService.resolve()` as of
 * this migration — see `015_seed_service_config_defaults.ts`'s own header for the full list of
 * call sites each key traces back to. If a future task adds a new resolved key without also
 * adding its own `GLOBAL` seed row (`01-DATABASE.md` §6's own instruction, added by this task),
 * this list intentionally does NOT grow to cover it automatically — that is exactly the gap this
 * task's own "Process note" warns a later task must close for itself. */
const EXPECTED_SEEDED_KEYS: ReadonlyArray<{ key: string; value: number }> = [
  { key: 'cache.ttl.serviceConfig.seconds', value: 60 },
  { key: 'cache.ttl.tenantSchemaConfig.seconds', value: 300 },
  { key: 'cache.ttl.externalRewardSystemConfig.seconds', value: 300 },
  { key: 'cache.ttl.dispatchChannelConfig.seconds', value: 300 },
  { key: 'cache.reconciliationPoll.intervalSeconds', value: 300 },
  { key: 'completionSweep.graceSeconds', value: 300 },
  { key: 'completionSweep.intervalSeconds', value: 60 },
];

/** Same substitution idiom as `service-config.repository.spec.ts`'s own `realDbConfigService()`. */
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

describe('T-RR-051 — service_config default GLOBAL seed rows', () => {
  let migrationDb: Sequelize;
  let repository: ServiceConfigRepository;
  let resolver: ServiceConfigResolverService;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    repository = new ServiceConfigRepository(realDbConfigService());
    resolver = new ServiceConfigResolverService(repository);
  });

  afterAll(async () => {
    await migrationDb.close();
    await repository.onModuleDestroy();
  });

  // TC-1/TC-2: reproduces (in row-count form) the exact defect T-RR-021 reported — before this
  // migration, this query returned zero rows for every one of these keys.
  it.each(EXPECTED_SEEDED_KEYS)(
    'TC-1/TC-2: exactly one GLOBAL row exists for "$key", value_type=int, scope_ref NULL',
    async ({ key }) => {
      const rows = await migrationDb.query<{
        config_value: string;
        value_type: string;
        scope_ref: string | null;
      }>(
        `SELECT config_value, value_type, scope_ref FROM reward_redemption.service_config
         WHERE config_key = :key AND scope_level = 'GLOBAL'`,
        { type: QueryTypes.SELECT, replacements: { key } },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].scope_ref).toBeNull();
      expect(rows[0].value_type).toBe('int');
    },
  );

  // TC-3 (the one that matters): the real resolver, unmocked, must actually resolve every one of
  // these keys with no scope context — this is the literal call shape `CompletionSweepService`,
  // `ServiceConfigCache`, `ReconciliationPollerService` and every cache-TTL reader in
  // `tenant-schema-cache/` make. Proven to fail on the unfixed code by direct reproduction: with
  // migration 015 rolled back, this same assertion throws `ServiceConfigNotFoundError` (see this
  // task's own completion report for the exact command run and output observed).
  it.each(EXPECTED_SEEDED_KEYS)(
    'TC-3: ServiceConfigResolverService.resolve("$key", "int") succeeds with no scope context and returns the seeded value',
    async ({ key, value }) => {
      await expect(resolver.resolve(key, 'int')).resolves.toBe(value);
    },
  );

  // TC-4: adjacent behaviour that must not change — an unrelated, genuinely unconfigured key still
  // throws exactly as before; this migration must not have introduced some blanket fallback.
  it('TC-4: a genuinely unconfigured key still throws ServiceConfigNotFoundError', async () => {
    await expect(resolver.resolve('t-rr-051.never.seeded.knob', 'int')).rejects.toThrow(
      'Unconfigured service_config key',
    );
  });

  // TC-4 (continued): the seed migration must not have touched any other scope level or any other
  // table — a narrow, auditable change only.
  it('TC-4: no non-GLOBAL row exists for any of the seeded keys (this migration only ever inserts GLOBAL rows)', async () => {
    const rows = await migrationDb.query<{ config_key: string }>(
      `SELECT config_key FROM reward_redemption.service_config
       WHERE config_key IN (:keys) AND scope_level != 'GLOBAL'`,
      {
        type: QueryTypes.SELECT,
        replacements: { keys: EXPECTED_SEEDED_KEYS.map((k) => k.key) },
      },
    );

    expect(rows).toHaveLength(0);
  });
});
