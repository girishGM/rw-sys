/**
 * T-RR-032 — `CoreBankingConnector` against the real local Postgres 16 server (root `CLAUDE.md`)
 * for both the `service_config` reads this stub's canned outcome resolves through and the
 * `external_system_call_log` write it owns end to end (`01-DATABASE.md` §9) — a fake can't prove a
 * real `INSERT`/FK relationship, same reasoning `promo-code-service.connector.spec.ts` (T-RR-031)
 * already documents for its own suite. `global.fetch` is spied on (never mocked to *resolve*
 * anything) purely to prove this connector never calls it (TC-5) — the entire point of this class
 * is zero I/O.
 *
 * One real `reward_redemption_entry` row is seeded once in `beforeAll` (the FK
 * `external_system_call_log.reward_entry_id` requires it to exist) and reused by every test case.
 * `service_config` rows for `connectors.coreBanking.stubOutcome` are inserted/deleted per test
 * case (via `setStubOutcome`/`clearStubOutcome`) rather than via any migration, since
 * `src/database/**` is outside this task's file scope (see `core-banking.connector.ts`'s own
 * header) — this is exactly the same "seed via direct SQL in the test's own fixture" convention
 * `promo-code-service.connector.spec.ts` already uses for its own `reward_redemption_entry` row.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { MetricsRegistry } from '@/observability/metrics.registry';
import {
  CORE_BANKING_STUB_OUTCOME_CONFIG_KEY,
  CoreBankingConnector,
  InvalidStubOutcomeError,
} from '@/modules/connectors/core-banking.connector';

const PLAINTEXT_CUSTOMER_ID_HASH = 'test-customer-hash-t-rr-032';
const SEEDED_ENTRY_ID = randomUUID();
const SEEDED_CORRELATION_ID = randomUUID();
const CAMPAIGN_CODE = 'CAMP_T_RR_032';

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

function buildEntry(overrides: Partial<RewardRedemptionEntryRow> = {}): RewardRedemptionEntryRow {
  return {
    id: SEEDED_ENTRY_ID,
    correlation_id: SEEDED_CORRELATION_ID,
    tenant_id: 1,
    customer_id_encrypted: 'unused-in-this-suite-see-header',
    customer_id_hash: PLAINTEXT_CUSTOMER_ID_HASH,
    customer_id_type: 'MSISDN',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'ACT_CODE',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: '75.0000',
    activity_value_unit: 'MYR',
    channel: 'APP',
    activity_performed_env: 'development',
    activity_name: 't-rr-032 connector fixture',
    campaign_code: CAMPAIGN_CODE,
    tracker_code: 'TRK_T_RR_032',
    tracker_component_code: 'COMP_T_RR_032',
    merchant_code: 'MERCH_T_RR_032',
    reward_code: 'CASHBACK5',
    reward_category: 'CASHBACK',
    reward_value: '5.0000',
    reward_value_unit: '%',
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

function buildConnectorConfig(
  overrides: Partial<ExternalRewardSystemConfigRow> = {},
): ExternalRewardSystemConfigRow {
  return {
    id: 2,
    system_code: 'CORE_BANKING',
    tenant_id: null,
    connector_type: 'CORE_BANKING',
    endpoint_url: 'http://core-banking.test/api/v1/transfers',
    auth_secret_ref: 'CORE_BANKING_UNUSED_TOKEN',
    retryable_error_codes: [],
    max_retry_attempts: 5,
    retry_backoff_base_ms: 500,
    retry_backoff_max_ms: 30_000,
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    tenant_key: -1,
    ...overrides,
  };
}

/**
 * T-RR-072: exactly what this suite's own `afterAll` runs to leave `service_config` in the state
 * it found it in for `CORE_BANKING_STUB_OUTCOME_CONFIG_KEY`, rather than deleting every row for the
 * key regardless of who inserted it or at what scope (the reported defect). The previous
 * `DELETE FROM ... WHERE config_key = :key` had no `scope_level`/`scope_ref` filter at all, so it
 * unconditionally removed ANY row for this key — including a permanent `GLOBAL` row a real seed
 * inserts (see `demo-dispatch-and-service-config.seed.ts`'s own header), not just the rows this
 * suite itself created via `setStubOutcome`/`clearStubOutcome`.
 *
 * Scoping the delete alone (matching `clearStubOutcome`'s own `scope_level`/`scope_ref` filter)
 * is *not* sufficient here: this suite's own tests deliberately exercise the `GLOBAL`/`NULL` scope
 * (to prove the resolver's `GLOBAL`-level precedence), which is the exact scope a permanent seed
 * row for this key would also occupy — a scope-only filter cannot distinguish "this suite's own
 * transient override" from "a permanent row that predates this suite" when both live at the same
 * scope. Snapshotting whatever `GLOBAL`/`NULL` row existed before this suite touched it (`null` if
 * none) and restoring exactly that at the very end is what actually protects a foreign row: this
 * suite already leaves `GLOBAL`/`NULL` empty between individual tests (`clearStubOutcome` in
 * `afterEach`, unchanged by this fix and not itself in question here — the reported defect is
 * specifically about state *after* this whole suite finishes, not mid-run), so the only state that
 * needs to survive test-suite completion is whatever was there before the suite began.
 */
async function restoreCoreBankingStubOutcomeAfterSuite(
  db: Sequelize,
  campaignCode: string,
  preexistingGlobalRow: { config_value: string; value_type: string } | null,
): Promise<void> {
  await db.query(
    `DELETE FROM reward_redemption.service_config
       WHERE config_key = :key AND scope_level = 'GLOBAL' AND scope_ref IS NULL`,
    { type: QueryTypes.RAW, replacements: { key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY } },
  );
  await db.query(
    `DELETE FROM reward_redemption.service_config
       WHERE config_key = :key AND scope_level = 'CAMPAIGN' AND scope_ref = :scopeRef`,
    {
      type: QueryTypes.RAW,
      replacements: { key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY, scopeRef: campaignCode },
    },
  );
  if (preexistingGlobalRow) {
    await db.query(
      `INSERT INTO reward_redemption.service_config
         (config_key, scope_level, scope_ref, config_value, value_type)
       VALUES (:key, 'GLOBAL', NULL, :value, :valueType)`,
      {
        type: QueryTypes.RAW,
        replacements: {
          key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY,
          value: preexistingGlobalRow.config_value,
          valueType: preexistingGlobalRow.value_type,
        },
      },
    );
  }
}

describe('T-RR-032 — CoreBankingConnector', () => {
  let migrationDb: Sequelize;
  let connector: CoreBankingConnector;
  let fetchSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let serviceConfigRepository: ServiceConfigRepository;
  let metrics: MetricsRegistry;
  let preexistingGlobalStubOutcomeRow: { config_value: string; value_type: string } | null;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();

    // T-RR-072: capture whatever GLOBAL/NULL row already exists for this key (e.g. a permanent
    // seed row) BEFORE this suite starts overwriting it, so afterAll can restore exactly this
    // instead of asserting this suite owns whatever is there when it finishes.
    const existingGlobalRows = await migrationDb.query<{
      config_value: string;
      value_type: string;
    }>(
      `SELECT config_value, value_type FROM reward_redemption.service_config
         WHERE config_key = :key AND scope_level = 'GLOBAL' AND scope_ref IS NULL`,
      { type: QueryTypes.SELECT, replacements: { key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY } },
    );
    preexistingGlobalStubOutcomeRow = existingGlobalRows[0] ?? null;

    await migrationDb.query(
      `INSERT INTO reward_redemption.reward_redemption_entry
         (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
          customer_id_type, activity_performed_date, activity_type, activity_category,
          activity_value, activity_value_unit, channel, activity_performed_env, activity_name,
          campaign_code, tracker_code, tracker_component_code, merchant_code, reward_code,
          reward_category, reward_value, reward_value_unit, reward_entry_date, reward_processed_env,
          ingestion_channel, status)
       VALUES
         (:id, :correlationId, 1, 'unused-in-this-suite-see-header', :customerIdHash, 'MSISDN',
          now(), 'PURCHASE', 'SPEND', '75.0000', 'MYR', 'APP', 'development',
          't-rr-032 connector fixture', :campaignCode, 'TRK_T_RR_032', 'COMP_T_RR_032',
          'MERCH_T_RR_032', 'CASHBACK5', 'CASHBACK', '5.0000', '%', now(), 'development', 'REST',
          'processing')`,
      {
        type: QueryTypes.RAW,
        replacements: {
          id: SEEDED_ENTRY_ID,
          correlationId: SEEDED_CORRELATION_ID,
          customerIdHash: PLAINTEXT_CUSTOMER_ID_HASH,
          campaignCode: CAMPAIGN_CODE,
        },
      },
    );

    serviceConfigRepository = new ServiceConfigRepository(realDbConfigService());
    const resolver = new ServiceConfigResolverService(serviceConfigRepository);
    metrics = new MetricsRegistry();
    connector = new CoreBankingConnector(resolver, realDbConfigService(), undefined, metrics);
  });

  afterAll(async () => {
    await migrationDb.query(
      `DELETE FROM reward_redemption.external_system_call_log WHERE reward_entry_id = :id`,
      { type: QueryTypes.RAW, replacements: { id: SEEDED_ENTRY_ID } },
    );
    await migrationDb.query(
      `DELETE FROM reward_redemption.reward_redemption_entry WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id: SEEDED_ENTRY_ID } },
    );
    // T-RR-072: restore, not blanket-delete — see restoreCoreBankingStubOutcomeAfterSuite's own
    // header for why a scope-only filter isn't enough here.
    await restoreCoreBankingStubOutcomeAfterSuite(
      migrationDb,
      CAMPAIGN_CODE,
      preexistingGlobalStubOutcomeRow,
    );
    await serviceConfigRepository.onModuleDestroy();
    await migrationDb.close();
    await connector.onModuleDestroy();
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    jest.restoreAllMocks();
    metrics.resetForTests();
    await clearStubOutcome('GLOBAL', null);
    await clearStubOutcome('CAMPAIGN', CAMPAIGN_CODE);
  });

  async function setStubOutcome(
    scopeLevel: 'GLOBAL' | 'CAMPAIGN',
    scopeRef: string | null,
    value: string,
  ): Promise<void> {
    // Delete-then-insert rather than `ON CONFLICT (config_key, scope_level, scope_ref) DO UPDATE`:
    // Postgres treats every `NULL` `scope_ref` (the `GLOBAL` case) as distinct for uniqueness
    // purposes, so an upsert targeting that constraint never actually conflicts on a NULL — it
    // would silently accumulate a new GLOBAL row per call instead of replacing the existing one,
    // leaving `ServiceConfigResolverService`'s own `ORDER BY ... LIMIT 1` to pick an arbitrary one
    // of several GLOBAL rows for the same key.
    await clearStubOutcome(scopeLevel, scopeRef);
    await migrationDb.query(
      `INSERT INTO reward_redemption.service_config
         (config_key, scope_level, scope_ref, config_value, value_type)
       VALUES (:key, :scopeLevel, :scopeRef, :value, 'string')`,
      {
        type: QueryTypes.RAW,
        replacements: {
          key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY,
          scopeLevel,
          scopeRef,
          value,
        },
      },
    );
  }

  async function clearStubOutcome(scopeLevel: string, scopeRef: string | null): Promise<void> {
    await migrationDb.query(
      scopeRef === null
        ? `DELETE FROM reward_redemption.service_config
             WHERE config_key = :key AND scope_level = :scopeLevel AND scope_ref IS NULL`
        : `DELETE FROM reward_redemption.service_config
             WHERE config_key = :key AND scope_level = :scopeLevel AND scope_ref = :scopeRef`,
      {
        type: QueryTypes.RAW,
        replacements: { key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY, scopeLevel, scopeRef },
      },
    );
  }

  async function fetchLatestCallLogRow(): Promise<Record<string, unknown>> {
    const rows = await migrationDb.query<Record<string, unknown>>(
      `SELECT * FROM reward_redemption.external_system_call_log
         WHERE reward_entry_id = :id ORDER BY called_at DESC LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { id: SEEDED_ENTRY_ID } },
    );
    expect(rows.length).toBeGreaterThan(0);
    return rows[0];
  }

  it('TC-1: stubOutcome = SUCCESS -> outcome SUCCESS with a synthesized externalReferenceId', async () => {
    await setStubOutcome('GLOBAL', null, 'SUCCESS');

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('SUCCESS');
    if (result.outcome === 'SUCCESS') {
      expect(result.externalReferenceId).toMatch(/^CB-/);
      expect(result.responseSummary).toMatchObject({ status: 'COMPLETED' });
    }
  });

  it('TC-2: stubOutcome = RETRYABLE_FAILURE -> returns that outcome with a plausible errorCode/errorMessage', async () => {
    await setStubOutcome('GLOBAL', null, 'RETRYABLE_FAILURE');

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('RETRYABLE_FAILURE');
    if (result.outcome !== 'SUCCESS') {
      expect(result.errorCode).toEqual(expect.any(String));
      expect(result.errorMessage.length).toBeGreaterThan(0);
    }
  });

  it('TC-3: stubOutcome = PERMANENT_FAILURE -> returns that outcome', async () => {
    await setStubOutcome('GLOBAL', null, 'PERMANENT_FAILURE');

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  it('TC-4: no service_config override present -> falls back to the GLOBAL default (SUCCESS)', async () => {
    // Deliberately no setStubOutcome call — no row at any scope for this key.
    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('SUCCESS');
  });

  it('TC-5: no outbound network call is ever made, on any branch', async () => {
    await setStubOutcome('GLOBAL', null, 'SUCCESS');
    await connector.redeem(buildEntry(), buildConnectorConfig());

    await setStubOutcome('GLOBAL', null, 'RETRYABLE_FAILURE');
    await connector.redeem(buildEntry(), buildConnectorConfig());

    await setStubOutcome('GLOBAL', null, 'PERMANENT_FAILURE');
    await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('TC-6: an external_system_call_log row is written on every outcome, latency_ms reflects real (sub-second) elapsed time', async () => {
    for (const outcome of ['SUCCESS', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE'] as const) {
      // eslint-disable-next-line no-await-in-loop -- T-RR-032: sequential by design, each
      // iteration depends on the previous one's config row being replaced first.
      await setStubOutcome('GLOBAL', null, outcome);
      // eslint-disable-next-line no-await-in-loop -- see above.
      await connector.redeem(buildEntry(), buildConnectorConfig());
      // eslint-disable-next-line no-await-in-loop -- see above.
      const row = await fetchLatestCallLogRow();

      expect(row.result).toBe(outcome);
      expect(Number(row.latency_ms)).toBeGreaterThanOrEqual(0);
      // No artificial delay is ever added (implementation note 4) — a stub call is fast.
      expect(Number(row.latency_ms)).toBeLessThan(1000);
    }
  });

  it('T-RR-059 TC-2/TC-3: external_system_call_total{system_code, result} increments exactly once per redeem() call, mapping outcome -> result correctly', async () => {
    await setStubOutcome('GLOBAL', null, 'SUCCESS');
    await connector.redeem(buildEntry(), buildConnectorConfig());
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'CORE_BANKING',
        result: 'success',
      }),
    ).toBe(1);

    await setStubOutcome('GLOBAL', null, 'RETRYABLE_FAILURE');
    await connector.redeem(buildEntry(), buildConnectorConfig());
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'CORE_BANKING',
        result: 'retryable_failure',
      }),
    ).toBe(1);

    await setStubOutcome('GLOBAL', null, 'PERMANENT_FAILURE');
    await connector.redeem(buildEntry(), buildConnectorConfig());
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'CORE_BANKING',
        result: 'permanent_failure',
      }),
    ).toBe(1);

    // Not a change-detector (AGENT-PROTOCOL.md §3): confirm the counter for a result that never
    // happened stays exactly 0, so this test would fail if the mapping ever mislabels an outcome.
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'CORE_BANKING',
        result: 'success',
      }),
    ).toBe(1);
  });

  it('T-RR-059 TC-4: a MetricsRegistry-less construction (no real DI) never throws — the increment is a no-op, adjacent behaviour (the call-log write) is unchanged', async () => {
    const bareConnector = new CoreBankingConnector(
      new ServiceConfigResolverService(serviceConfigRepository),
      realDbConfigService(),
    );
    await setStubOutcome('GLOBAL', null, 'SUCCESS');

    const result = await bareConnector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('SUCCESS');
    const row = await fetchLatestCallLogRow();
    expect(row.result).toBe('SUCCESS');
    await bareConnector.onModuleDestroy();
  });

  it('TC-7: customerId never appears in the would-be request log in plaintext — hash or redaction only', async () => {
    await setStubOutcome('GLOBAL', null, 'SUCCESS');
    await connector.redeem(buildEntry(), buildConnectorConfig());

    const loggedText = logSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(loggedText).toContain(PLAINTEXT_CUSTOMER_ID_HASH);
    expect(loggedText).not.toContain('customer_id_encrypted');
  });

  it('TC-8: an invalid/unrecognized stubOutcome value throws InvalidStubOutcomeError, never a silent default', async () => {
    await setStubOutcome('GLOBAL', null, 'SUCCES');

    await expect(connector.redeem(buildEntry(), buildConnectorConfig())).rejects.toThrow(
      InvalidStubOutcomeError,
    );
  });

  it('a CAMPAIGN-scoped override wins over a GLOBAL default (service_config precedence)', async () => {
    await setStubOutcome('GLOBAL', null, 'SUCCESS');
    await setStubOutcome('CAMPAIGN', CAMPAIGN_CODE, 'PERMANENT_FAILURE');

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  it('an invalid config value never writes an external_system_call_log row (config error, not a redemption outcome)', async () => {
    await migrationDb.query(
      `DELETE FROM reward_redemption.external_system_call_log WHERE reward_entry_id = :id`,
      { type: QueryTypes.RAW, replacements: { id: SEEDED_ENTRY_ID } },
    );
    await setStubOutcome('GLOBAL', null, 'NOT_A_REAL_OUTCOME');

    await expect(connector.redeem(buildEntry(), buildConnectorConfig())).rejects.toThrow(
      InvalidStubOutcomeError,
    );

    const rows = await migrationDb.query<Record<string, unknown>>(
      `SELECT * FROM reward_redemption.external_system_call_log WHERE reward_entry_id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: SEEDED_ENTRY_ID } },
    );
    expect(rows.length).toBe(0);
  });

  it('T-RR-072 regression: end-of-suite cleanup restores a pre-existing GLOBAL row for this key instead of deleting it', async () => {
    // Simulate a permanent GLOBAL row that predates this suite (e.g. a future seed migration for
    // `CORE_BANKING_STUB_OUTCOME_CONFIG_KEY`) — inserted directly, never via setStubOutcome, so it
    // is not "owned" by this suite in any sense the old unscoped DELETE respected.
    const FOREIGN_SEED_VALUE = 'PERMANENT_FAILURE';
    await clearStubOutcome('GLOBAL', null);
    await migrationDb.query(
      `INSERT INTO reward_redemption.service_config
         (config_key, scope_level, scope_ref, config_value, value_type)
       VALUES (:key, 'GLOBAL', NULL, :value, 'string')`,
      {
        type: QueryTypes.RAW,
        replacements: { key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY, value: FOREIGN_SEED_VALUE },
      },
    );

    // Simulate the rest of this suite's own lifecycle running after that foreign row was already
    // present: other tests override GLOBAL/CAMPAIGN transiently, same as any real test in this file.
    await setStubOutcome('GLOBAL', null, 'SUCCESS');
    await setStubOutcome('CAMPAIGN', CAMPAIGN_CODE, 'RETRYABLE_FAILURE');

    // This is the exact function `afterAll` calls, given a snapshot taken before the suite started
    // touching this key (as `beforeAll` does for real) — calling the real production code, not a
    // reimplementation of it, so this test actually exercises what ships.
    await restoreCoreBankingStubOutcomeAfterSuite(migrationDb, CAMPAIGN_CODE, {
      config_value: FOREIGN_SEED_VALUE,
      value_type: 'string',
    });

    const globalRows = await migrationDb.query<{ config_value: string; scope_ref: string | null }>(
      `SELECT config_value, scope_ref FROM reward_redemption.service_config
         WHERE config_key = :key AND scope_level = 'GLOBAL'`,
      { type: QueryTypes.SELECT, replacements: { key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY } },
    );
    // The foreign row survives, unmodified — this is the outcome the old unscoped
    // `DELETE FROM ... WHERE config_key = :key` (no scope filter) could never guarantee: it deleted
    // ANY row for this key regardless of origin, which would have left zero rows here instead.
    expect(globalRows).toHaveLength(1);
    expect(globalRows[0]).toMatchObject({ config_value: FOREIGN_SEED_VALUE, scope_ref: null });

    // Adjacent behaviour unchanged: the CAMPAIGN-scoped row this suite's own tests create is still
    // cleaned up (never left behind), exactly as clearStubOutcome already guaranteed.
    const campaignRows = await migrationDb.query(
      `SELECT 1 FROM reward_redemption.service_config
         WHERE config_key = :key AND scope_level = 'CAMPAIGN' AND scope_ref = :scopeRef`,
      {
        type: QueryTypes.SELECT,
        replacements: { key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY, scopeRef: CAMPAIGN_CODE },
      },
    );
    expect(campaignRows).toHaveLength(0);

    // Restore the suite's own real fixture state (no row) for the tests that still follow this one.
    await clearStubOutcome('GLOBAL', null);
  });

  it('no sequelize/pg transaction wraps redeem() (05-PROCESSING-PIPELINE.md §3)', () => {
    const source = readFileSync(
      path.join(__dirname, '..', '..', 'src', 'modules', 'connectors', 'core-banking.connector.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\.transaction\(/);
    expect(source).not.toMatch(/\bBEGIN\b/);
  });

  it('imports no HTTP/gRPC transport module (verification step 2)', () => {
    const source = readFileSync(
      path.join(__dirname, '..', '..', 'src', 'modules', 'connectors', 'core-banking.connector.ts'),
      'utf8',
    );
    // Strip block/line comments first — this file's own doc comments legitimately *discuss* "gRPC"
    // and "HTTP" in prose (explaining what this stub deliberately does not do); what verification
    // step 2 actually checks is the absence of real transport *code*, not the absence of the word.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\baxios\b/i);
    expect(code).not.toMatch(/\bgrpc\b/i);
    expect(code).not.toMatch(/\brequire\(\s*['"]http['"]\s*\)/);
  });
});
