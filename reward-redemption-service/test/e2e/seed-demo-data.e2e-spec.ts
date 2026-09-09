/**
 * T-RR-046 regression suite for this task's own demo/seed-data CLI
 * (`src/database/seeds/index.ts` + `*.seed.ts`). Runs against the real Postgres 16 server
 * documented in root `CLAUDE.md`, connected via the same privileged migration role
 * `test/database/*.migration.spec.ts` already use (`createMigrationConnection`) — no mock, no
 * in-memory DB, same convention as every other migration-shaped suite in this project. Assumes
 * the schema migrations (`src/database/migrations/**`) are already applied, exactly as those
 * suites do — proven separately by the bash `npm run db:migrate && npm run db:rollback && npm
 * run db:migrate` gate (`AGENT-PROTOCOL.md` §4).
 *
 * Exercises the seed migrator's own up → down → up round trip (TC-4/TC-5, and — since the seed
 * chain is its own independent Umzug instance, `seed-migrator.ts`'s own header — the identical
 * "clean re-migrate after rollback" property `AGENT-PROTOCOL.md` §4's gate proves for the schema
 * chain), asserting the real observable property at each step (the actual rows in Postgres), not
 * just that the CLI printed success. Left in the "seeded" (up) state when this suite finishes —
 * this is demo data meant to exist for a demo, not scratch data to be cleaned away — but the
 * `afterAll` still tolerates running against a database that already had this task's demo rows
 * present before the suite started (`seeder.up()` is a no-op for an already-applied seed, exactly
 * like `db:migrate` against an already-migrated schema).
 */
import 'reflect-metadata';
import type { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { createSeedMigrator } from '@/database/seeds/seed-migrator';
import type { Config } from '@/config/config.schema';
import { ExternalRewardSystemConfigRepository } from '@/modules/tenant-schema-cache/external-reward-system-config.repository';
import { ExternalRewardSystemConfigCache } from '@/modules/tenant-schema-cache/external-reward-system-config.cache';
import { ExternalRewardSystemConfigResolver } from '@/modules/reward-system-config/external-reward-system-config.resolver';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';

/** Same substitution idiom as `campaign-config-ttl-seed.migration.spec.ts`'s own
 * `realDbConfigService()` — a minimal, real (non-mocked) `ConfigService` stand-in carrying only
 * the `rr_app` least-privilege runtime credentials `ExternalRewardSystemConfigRepository`/
 * `ServiceConfigRepository` themselves read, so this file's own T-INT-048 test below constructs
 * and exercises the *actual* production resolver classes against the real seeded row, not a
 * fixture standing in for them. */
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

describe('T-RR-046 — demo/seed data (src/database/seeds/**)', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    // Leave the demo dataset seeded (see file header) — re-apply in case this suite's own body
    // left it rolled back for any reason (a failed assertion mid-test, for instance).
    const seeder = createSeedMigrator(sequelize);
    await seeder.up();
    await sequelize.close();
  });

  it('TC-4/TC-6: seeding against a real local Postgres inserts every demo row this task owns, with realistic values', async () => {
    const seeder = createSeedMigrator(sequelize);
    // Defensive: start from a known "seeded" state regardless of what an earlier suite run (or a
    // manual `npm run db:seed`) left behind.
    await seeder.up();

    const [tenant] = await sequelize.query<{
      tenant_id: number;
      tenant_code: string;
      country_code: string;
      environment: string;
      database_name: string;
      schema_name: string;
      is_active: boolean;
    }>(
      `SELECT tenant_id, tenant_code, country_code, environment, database_name, schema_name, is_active
       FROM reward_redemption.tenant_schema_config
       WHERE tenant_code = 'TEN-MY'`,
      { type: QueryTypes.SELECT },
    );
    expect(tenant).toMatchObject({
      tenant_id: 1,
      tenant_code: 'TEN-MY',
      country_code: 'MY',
      environment: 'production',
      database_name: 'reward_system',
      schema_name: 'reward_redemption',
      is_active: true,
    });
    // Not a placeholder-looking value (TC-4's own "no test-tenant-1/foo" requirement) — a real
    // tenant code shaped like this plan's own design-doc examples, not a generic literal.
    expect(tenant.tenant_code).not.toMatch(/^test-tenant|^foo$/i);

    // T-INT-048: resolution is keyed by the reward's own system_code (`PROMO_VOUCHER`, the real
    // `reward_config.reward_systems.system_code` this plan's seeded `WEEKEND_PROMO_BLITZ`
    // campaign's reward actually carries) — not the connector's own name.
    const [connector] = await sequelize.query<{
      system_code: string;
      tenant_id: number | null;
      connector_type: string;
      endpoint_url: string;
      auth_secret_ref: string;
      retryable_error_codes: string[];
      status: string;
    }>(
      `SELECT system_code, tenant_id, connector_type, endpoint_url, auth_secret_ref,
              retryable_error_codes, status
       FROM reward_redemption.external_reward_system_config
       WHERE system_code = 'PROMO_VOUCHER' AND tenant_id IS NULL`,
      { type: QueryTypes.SELECT },
    );
    expect(connector).toMatchObject({
      system_code: 'PROMO_VOUCHER',
      tenant_id: null,
      connector_type: 'PROMO_CODE_SERVICE',
      auth_secret_ref: 'GENERATION_SERVICE_TOKEN',
      status: 'active',
    });
    expect(connector.retryable_error_codes).toEqual(['GENERATION_EXHAUSTED']);
    // auth_secret_ref must be an env var NAME, never a credential value (R9/TC-8) — a real secret
    // would not look like a valid environment-variable identifier shaped exactly like this
    // service's own documented token names.
    expect(connector.auth_secret_ref).toMatch(/^[A-Z][A-Z0-9_]*$/);

    // TC-6: every service_config key this task's own seed adds, with the documented default.
    // `connectors.coreBanking.stubOutcome` is deliberately excluded — see
    // `demo-dispatch-and-service-config.seed.ts`'s own header (T-RR-072: seeding it collides with
    // `test/connectors/core-banking.connector.spec.ts`'s own unscoped teardown DELETE).
    const EXPECTED_KEYS: ReadonlyArray<{ key: string; value: string; valueType: string }> = [
      { key: 'dispatch.kafka.attemptsBeforeFallback', value: '3', valueType: 'int' },
      { key: 'dispatch.outbox.pollIntervalSeconds', value: '5', valueType: 'int' },
      { key: 'dispatch.retry.maxAttempts', value: '5', valueType: 'int' },
    ];
    for (const expected of EXPECTED_KEYS) {
      // eslint-disable-next-line no-await-in-loop -- T-RR-046: a handful of sequential SELECTs in
      // a test body, no throughput concern.
      const rows = await sequelize.query<{
        config_value: string;
        value_type: string;
        scope_ref: string | null;
      }>(
        `SELECT config_value, value_type, scope_ref FROM reward_redemption.service_config
         WHERE config_key = :key AND scope_level = 'GLOBAL'`,
        { type: QueryTypes.SELECT, replacements: { key: expected.key } },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].scope_ref).toBeNull();
      expect(rows[0].config_value).toBe(expected.value);
      expect(rows[0].value_type).toBe(expected.valueType);
    }

    // This task deliberately does not re-seed dispatch_channel_config's own GLOBAL row (already
    // seeded by 006_create_dispatch_channel_config.ts) — confirm exactly one GLOBAL row still
    // exists (no duplicate ever got inserted by this task's own seed).
    const dispatchGlobalRows = await sequelize.query(
      `SELECT id FROM reward_redemption.dispatch_channel_config
       WHERE scope_level = 'GLOBAL' AND scope_ref_code IS NULL AND tenant_id IS NULL`,
      { type: QueryTypes.SELECT },
    );
    expect(dispatchGlobalRows).toHaveLength(1);
  });

  // T-INT-048 TC-2/TC-3. Exercises the real, unmocked production resolution stack
  // (`ExternalRewardSystemConfigRepository` -> `ExternalRewardSystemConfigCache` ->
  // `ExternalRewardSystemConfigResolver`, the exact classes
  // `RewardSystemResolutionService`/`RedemptionProcessingOrchestrator` call in production) against
  // the real seeded row — not just a raw SQL SELECT (TC-4/TC-6 above) and not a mocked fixture
  // (every other `external-reward-system-config.*.spec.ts` in this service). This is the test that
  // would have caught T-INT-048's own defect: before the fix, `resolve('PROMO_VOUCHER', null)`
  // returned `null` (no active config, correctly, but for the wrong reason — the seed's
  // `system_code` never matched any real reward), which is indistinguishable, from the caller's
  // side, from a reward that genuinely has no external system configured.
  it('TC-2: the real ExternalRewardSystemConfigResolver resolves an active config for system_code="PROMO_VOUCHER" (WEEKEND_PROMO_BLITZ\'s real reward) — proves resolution, not just the raw row', async () => {
    const seeder = createSeedMigrator(sequelize);
    await seeder.up();

    const repository = new ExternalRewardSystemConfigRepository(realDbConfigService());
    const serviceConfigRepository = new ServiceConfigRepository(realDbConfigService());
    const serviceConfigResolver = new ServiceConfigResolverService(serviceConfigRepository);
    const serviceConfigCache = new ServiceConfigCache(
      serviceConfigResolver,
      serviceConfigRepository,
    );
    const cache = new ExternalRewardSystemConfigCache(repository, serviceConfigCache);
    const resolver = new ExternalRewardSystemConfigResolver(cache);

    try {
      const resolved = await resolver.resolve('PROMO_VOUCHER', null);
      expect(resolved).not.toBeNull();
      expect(resolved).toMatchObject({
        system_code: 'PROMO_VOUCHER',
        connector_type: 'PROMO_CODE_SERVICE',
        status: 'active',
      });

      // TC-3 (regression, same real stack): a system_code with genuinely no seeded row still
      // resolves to null — this fix must not make every reward resolve a connector
      // unconditionally.
      const unresolved = await resolver.resolve('T_INT_048_NO_SUCH_REWARD_SYSTEM', null);
      expect(unresolved).toBeNull();
    } finally {
      await repository.onModuleDestroy();
      await serviceConfigRepository.onModuleDestroy();
    }
  });

  it("TC-5: the seed script's own rollback removes exactly the demo rows it inserted, nothing else", async () => {
    const seeder = createSeedMigrator(sequelize);
    await seeder.up();

    const [beforeTenantCount] = await sequelize.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM reward_redemption.tenant_schema_config`,
      { type: QueryTypes.SELECT },
    );
    const [beforeConnectorCount] = await sequelize.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM reward_redemption.external_reward_system_config`,
      { type: QueryTypes.SELECT },
    );

    await seeder.down({ to: 0 });

    const tenantRows = await sequelize.query(
      `SELECT id FROM reward_redemption.tenant_schema_config WHERE tenant_code = 'TEN-MY'`,
      { type: QueryTypes.SELECT },
    );
    expect(tenantRows).toHaveLength(0);

    const connectorRows = await sequelize.query(
      `SELECT id FROM reward_redemption.external_reward_system_config
       WHERE system_code = 'PROMO_VOUCHER' AND tenant_id IS NULL`,
      { type: QueryTypes.SELECT },
    );
    expect(connectorRows).toHaveLength(0);

    // Scoped to GLOBAL only (not just "any row for this key") — this task's own seed only ever
    // inserts a GLOBAL row for each of these three keys, and scoping the check this way avoids a
    // false failure if some other, concurrently-running suite happens to hold its own
    // differently-scoped row for one of these keys at the same instant (`connectors.coreBanking.
    // stubOutcome` is deliberately excluded from this list — this task's own seed never inserts a
    // row for it at all, see `demo-dispatch-and-service-config.seed.ts`'s own header, T-RR-072).
    const configRows = await sequelize.query(
      `SELECT config_key FROM reward_redemption.service_config
       WHERE config_key IN (
         'dispatch.kafka.attemptsBeforeFallback', 'dispatch.outbox.pollIntervalSeconds',
         'dispatch.retry.maxAttempts'
       ) AND scope_level = 'GLOBAL' AND scope_ref IS NULL`,
      { type: QueryTypes.SELECT },
    );
    expect(configRows).toHaveLength(0);

    // "Nothing else" — exactly one row (this task's own demo tenant/connector) was ever present
    // in each of these tables attributable to this seed, so removing it drops each table's own
    // count by exactly one, never more.
    const [afterTenantCount] = await sequelize.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM reward_redemption.tenant_schema_config`,
      { type: QueryTypes.SELECT },
    );
    const [afterConnectorCount] = await sequelize.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM reward_redemption.external_reward_system_config`,
      { type: QueryTypes.SELECT },
    );
    expect(Number(afterTenantCount.count)).toBe(Number(beforeTenantCount.count) - 1);
    expect(Number(afterConnectorCount.count)).toBe(Number(beforeConnectorCount.count) - 1);

    // dispatch_channel_config's own pre-existing GLOBAL row (006's own migration) must be
    // untouched by this rollback.
    const dispatchGlobalRows = await sequelize.query(
      `SELECT id FROM reward_redemption.dispatch_channel_config
       WHERE scope_level = 'GLOBAL' AND scope_ref_code IS NULL AND tenant_id IS NULL`,
      { type: QueryTypes.SELECT },
    );
    expect(dispatchGlobalRows).toHaveLength(1);

    // Prove the clean re-seed cycle too (mirrors AGENT-PROTOCOL.md §4's migrate/rollback/migrate
    // gate, for this independent seed chain).
    await seeder.up();
    const tenantRowsAfterReseed = await sequelize.query(
      `SELECT id FROM reward_redemption.tenant_schema_config WHERE tenant_code = 'TEN-MY'`,
      { type: QueryTypes.SELECT },
    );
    expect(tenantRowsAfterReseed).toHaveLength(1);
  });
});
