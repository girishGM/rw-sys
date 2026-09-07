/**
 * T-RR-065 — `TenantSchemaEnrichmentService`. `06-CACHING-AND-TENANT-CONFIG.md` §5's claim-time
 * `tenant_code`/`country_code` enrichment step, implemented in `reward-system-resolution.service.ts`
 * (that file's own T-RR-065 header explains why). Two layers, matching this service's own general
 * test-pyramid convention:
 *
 * - The first `describe` block below is a pure unit-test layer: a fake `TenantSchemaConfigCache`
 *   (same "construct directly, cast through `unknown`" idiom `campaign-config.cache.spec.ts`
 *   already established for `ServiceConfigCache`) plus a fake `pg.Pool`, isolating this class's own
 *   branching (already-enriched short-circuit, the "expect exactly one" invariant, the UPDATE call
 *   shape) from any real I/O.
 * - The second is a real-Postgres integration layer (`reward-redemption-entry-claim.repository
 *   .spec.ts`'s own "exercised against the real Postgres 16 server ... never a mock/in-memory DB"
 *   convention) proving the UPDATE actually persists and that a real `TenantSchemaConfigCache` +
 *   `TenantSchemaConfigRepository` round trip resolves correctly end to end.
 *
 * TC-1 (this task's own minimum set) — "reproduce the reported defect" — is exercised in
 * `redemption-processing-orchestrator.service.spec.ts`'s own "T-RR-065" describe block instead of
 * here: the reported symptom is specifically "nothing ever calls this enrichment step from the
 * pipeline", which is a property of the orchestrator's own wiring, not of this class in isolation.
 * TC-3's own regression proof (this class did not exist at all before this task) is every test
 * below — none of them could have passed against the pre-fix tree, since `TenantSchemaEnrichmentService`
 * itself is new.
 */
import { randomUUID } from 'node:crypto';
import { Sequelize, QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import { createMigrationConnection } from '@/database/migration-connection';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { TenantSchemaConfigRow } from '@/database/models/tenant-schema-config.model';
import {
  TenantSchemaEnrichmentService,
  TenantSchemaResolutionError,
} from '@/modules/processing/reward-system-resolution.service';
import { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';
import { TenantSchemaConfigRepository } from '@/modules/tenant-schema-cache/tenant-schema-config.repository';
import type { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';

function buildEntry(overrides: Partial<RewardRedemptionEntryRow> = {}): RewardRedemptionEntryRow {
  return {
    id: randomUUID(),
    correlation_id: randomUUID(),
    tenant_id: 1,
    customer_id_encrypted: 'ciphertext-placeholder',
    customer_id_hash: 'hash-placeholder',
    customer_id_type: 'EMAIL',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'ACT_CODE',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: '10',
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 't-rr-065 enrichment fixture',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'CASHBACK',
    reward_value: '5',
    reward_value_unit: 'USD',
    reward_entry_date: new Date(),
    completion_cycle: 1,
    reward_processed_env: 'development',
    country_code: null,
    tenant_code: null,
    ingestion_channel: 'REST',
    status: 'processing',
    retry_count: 0,
    next_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    last_attempted_at: null,
    external_system_code: null,
    external_reference_id: null,
    redeemed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function buildTenantSchemaRow(
  overrides: Partial<TenantSchemaConfigRow> = {},
): TenantSchemaConfigRow {
  return {
    id: 1,
    tenant_id: 1,
    tenant_code: 'TENANT1',
    country_code: 'US',
    environment: 'development',
    database_name: 'reward_system',
    schema_name: 'reward_redemption',
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function fakeConfigService(nodeEnv = 'development'): ConfigService<Config, true> {
  const values: Partial<Config> = { NODE_ENV: nodeEnv as Config['NODE_ENV'] };
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

describe('T-RR-065 — TenantSchemaEnrichmentService (unit, fake cache + fake pool)', () => {
  function build(cacheRows: TenantSchemaConfigRow[] | Error) {
    const get = jest.fn();
    if (cacheRows instanceof Error) {
      get.mockRejectedValue(cacheRows);
    } else {
      get.mockResolvedValue(cacheRows);
    }
    const cache = { get } as unknown as TenantSchemaConfigCache;
    const query = jest.fn();
    const pool = { query } as unknown as Pool;
    const service = new TenantSchemaEnrichmentService(fakeConfigService(), cache, pool);
    return { service, get, query };
  }

  it('TC-A: an already-enriched entry (non-NULL tenant_code/country_code) is returned unchanged — the cache and pool are never touched', async () => {
    const { service, get, query } = build([]);
    const entry = buildEntry({ tenant_code: 'ALREADY', country_code: 'DE' });

    const result = await service.enrich(entry);

    expect(result).toBe(entry);
    expect(get).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('TC-B: exactly one active tenant_schema_config row resolves — persists tenant_code/country_code via UPDATE ... RETURNING * and returns the fresh row', async () => {
    const resolvedRow = buildTenantSchemaRow({ tenant_code: 'TENANT9', country_code: 'FR' });
    const { service, get, query } = build([resolvedRow]);
    const entry = buildEntry({ tenant_id: 42 });
    const updatedRow = { ...entry, tenant_code: 'TENANT9', country_code: 'FR' };
    query.mockResolvedValue({ rows: [updatedRow] });

    const result = await service.enrich(entry);

    expect(get).toHaveBeenCalledWith({ tenantId: 42, environment: 'development' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE reward_redemption.reward_redemption_entry'),
      ['TENANT9', 'FR', entry.id],
    );
    expect(result).toEqual(updatedRow);
  });

  it('TC-C (06-CACHING-AND-TENANT-CONFIG.md §5 point 2): zero active rows -> TenantSchemaResolutionError, never guessed at, no UPDATE issued', async () => {
    const { service, query } = build([]);
    const entry = buildEntry({ tenant_id: 7 });

    await expect(service.enrich(entry)).rejects.toBeInstanceOf(TenantSchemaResolutionError);
    expect(query).not.toHaveBeenCalled();
  });

  it('TC-D (06-CACHING-AND-TENANT-CONFIG.md §5 point 2): more than one active row -> TenantSchemaResolutionError, never guessed at, no UPDATE issued', async () => {
    const { service, query } = build([
      buildTenantSchemaRow({ country_code: 'US' }),
      buildTenantSchemaRow({ country_code: 'CA' }),
    ]);
    const entry = buildEntry({ tenant_id: 7 });

    await expect(service.enrich(entry)).rejects.toThrow(/matched 2 active row/);
    expect(query).not.toHaveBeenCalled();
  });

  it('TC-E (negative, structurally unreachable in production): the UPDATE returns no row -> throws loudly rather than returning undefined', async () => {
    const { service, query } = build([buildTenantSchemaRow()]);
    query.mockResolvedValue({ rows: [] });

    await expect(service.enrich(buildEntry())).rejects.toThrow(/returned no row/);
  });

  it('propagates a cache failure rather than silently proceeding', async () => {
    const { service } = build(new Error('tenant_schema_config lookup failed'));

    await expect(service.enrich(buildEntry())).rejects.toThrow(
      'tenant_schema_config lookup failed',
    );
  });
});

/**
 * Real-Postgres integration layer — a real `TenantSchemaConfigCache`/`TenantSchemaConfigRepository`
 * pair (T-RR-007) and a real `reward_redemption_entry` row, proving the UPDATE this service issues
 * actually persists and that `06-CACHING-AND-TENANT-CONFIG.md` §5's own filter
 * `(tenant_id, environment, is_active)` is exactly what gets queried.
 */
describe('T-RR-065 — TenantSchemaEnrichmentService (real Postgres)', () => {
  const TENANT_ID = 965_000 + Math.floor(Math.random() * 1000);
  const ZERO_MATCH_TENANT_ID = TENANT_ID + 1;
  const MULTI_MATCH_TENANT_ID = TENANT_ID + 2;
  let migrationDb: Sequelize;
  let service: TenantSchemaEnrichmentService;
  let pool: Pool;

  function realDbConfigService(): ConfigService<Config, true> {
    const values: Partial<Config> = {
      DB_HOST: process.env.DB_HOST,
      DB_PORT: Number(process.env.DB_PORT),
      DB_NAME: process.env.DB_NAME,
      DB_SSL: process.env.DB_SSL === 'true',
      DB_APP_USERNAME: process.env.DB_APP_USERNAME,
      DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
      NODE_ENV: 'development',
    };
    return {
      get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
    } as ConfigService<Config, true>;
  }

  async function insertEntry(tenantId: number): Promise<string> {
    const [row] = await migrationDb.query<{ id: string }>(
      `INSERT INTO reward_redemption.reward_redemption_entry
         (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
          activity_performed_date, transaction_type, activity_code, activity_type,
          activity_category, activity_value, activity_value_unit, channel, activity_performed_env,
          activity_name, campaign_code, tracker_code, tracker_component_code, merchant_code,
          reward_code, reward_category, reward_value, reward_value_unit, reward_entry_date,
          completion_cycle, reward_processed_env, ingestion_channel, status, retry_count,
          next_attempt_at, created_at)
       VALUES
         (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
          :customer_id_type, :activity_performed_date, :transaction_type, :activity_code,
          :activity_type, :activity_category, :activity_value, :activity_value_unit, :channel,
          :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
          :tracker_component_code, :merchant_code, :reward_code, :reward_category, :reward_value,
          :reward_value_unit, :reward_entry_date, :completion_cycle, :reward_processed_env,
          :ingestion_channel, :status, :retry_count, :next_attempt_at, :created_at)
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          id: randomUUID(),
          correlation_id: randomUUID(),
          tenant_id: tenantId,
          customer_id_encrypted: 'ciphertext-placeholder',
          customer_id_hash: `hash-${randomUUID()}`,
          customer_id_type: 'EMAIL',
          activity_performed_date: new Date(),
          transaction_type: null,
          activity_code: 'ACT_CODE',
          activity_type: 'PURCHASE',
          activity_category: 'SPEND',
          activity_value: 10,
          activity_value_unit: 'USD',
          channel: 'WEB',
          activity_performed_env: 'PROD',
          activity_name: 't-rr-065 real-pg fixture',
          campaign_code: 'CAMP1',
          tracker_code: 'TRK1',
          tracker_component_code: 'COMP1',
          merchant_code: null,
          reward_code: 'RWD1',
          reward_category: 'CASHBACK',
          reward_value: 5,
          reward_value_unit: 'USD',
          reward_entry_date: new Date(),
          completion_cycle: 1,
          reward_processed_env: 'development',
          ingestion_channel: 'REST',
          status: 'processing',
          retry_count: 0,
          next_attempt_at: null,
          created_at: new Date(),
        },
      },
    );
    return row.id;
  }

  async function fetchEntry(
    id: string,
  ): Promise<{ tenant_code: string | null; country_code: string | null }> {
    const [row] = await migrationDb.query<{
      tenant_code: string | null;
      country_code: string | null;
    }>(
      'SELECT tenant_code, country_code FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return row;
  }

  async function seedTenantSchemaConfig(
    tenantId: number,
    countryCode: string,
    tenantCode: string,
  ): Promise<void> {
    await migrationDb.query(
      `INSERT INTO reward_redemption.tenant_schema_config
         (tenant_id, tenant_code, country_code, environment, database_name, schema_name, is_active)
       VALUES (:tenant_id, :tenant_code, :country_code, 'development', 'reward_system', 'reward_redemption', true)`,
      {
        type: QueryTypes.RAW,
        replacements: { tenant_id: tenantId, tenant_code: tenantCode, country_code: countryCode },
      },
    );
  }

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    const repository = new TenantSchemaConfigRepository(realDbConfigService());
    const fakeServiceConfigCache = { resolve: async () => 60 } as unknown as ServiceConfigCache;
    const cache = new TenantSchemaConfigCache(repository, fakeServiceConfigCache);
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    service = new TenantSchemaEnrichmentService(realDbConfigService(), cache, pool);

    await seedTenantSchemaConfig(TENANT_ID, 'US', 'TENANT_TRR065');
    await seedTenantSchemaConfig(MULTI_MATCH_TENANT_ID, 'US', 'TENANT_TRR065_A');
    await seedTenantSchemaConfig(MULTI_MATCH_TENANT_ID, 'CA', 'TENANT_TRR065_B');
  }, 60_000);

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id IN (:ids)',
      {
        type: QueryTypes.RAW,
        replacements: { ids: [TENANT_ID, ZERO_MATCH_TENANT_ID, MULTI_MATCH_TENANT_ID] },
      },
    );
    await migrationDb.query(
      'DELETE FROM reward_redemption.tenant_schema_config WHERE tenant_id IN (:ids)',
      {
        type: QueryTypes.RAW,
        replacements: { ids: [TENANT_ID, ZERO_MATCH_TENANT_ID, MULTI_MATCH_TENANT_ID] },
      },
    );
    await pool.end();
    await migrationDb.close();
  }, 60_000);

  it('TC-2: resolves the one active tenant_schema_config row for (tenant_id, environment) and persists tenant_code/country_code onto the real row', async () => {
    const entryId = await insertEntry(TENANT_ID);
    const entry = buildEntry({ id: entryId, tenant_id: TENANT_ID });

    const result = await service.enrich(entry);

    expect(result.tenant_code).toBe('TENANT_TRR065');
    expect(result.country_code).toBe('US');

    const persisted = await fetchEntry(entryId);
    expect(persisted.tenant_code).toBe('TENANT_TRR065');
    expect(persisted.country_code).toBe('US');
  });

  it('TC-idempotent: a second enrich() call on the already-enriched result makes no further DB round trip and returns the identical row', async () => {
    const entryId = await insertEntry(TENANT_ID);
    const entry = buildEntry({ id: entryId, tenant_id: TENANT_ID });

    const first = await service.enrich(entry);
    const second = await service.enrich(first);

    expect(second).toBe(first);
  });

  it('TC-C (real Postgres): zero active tenant_schema_config rows for this tenant -> TenantSchemaResolutionError', async () => {
    const entryId = await insertEntry(ZERO_MATCH_TENANT_ID);
    const entry = buildEntry({ id: entryId, tenant_id: ZERO_MATCH_TENANT_ID });

    await expect(service.enrich(entry)).rejects.toBeInstanceOf(TenantSchemaResolutionError);

    const persisted = await fetchEntry(entryId);
    expect(persisted.tenant_code).toBeNull();
    expect(persisted.country_code).toBeNull();
  });

  it('TC-D (real Postgres): more than one active tenant_schema_config row for this tenant -> TenantSchemaResolutionError, never guessed at', async () => {
    const entryId = await insertEntry(MULTI_MATCH_TENANT_ID);
    const entry = buildEntry({ id: entryId, tenant_id: MULTI_MATCH_TENANT_ID });

    await expect(service.enrich(entry)).rejects.toThrow(/matched 2 active row/);

    const persisted = await fetchEntry(entryId);
    expect(persisted.tenant_code).toBeNull();
    expect(persisted.country_code).toBeNull();
  });
});
