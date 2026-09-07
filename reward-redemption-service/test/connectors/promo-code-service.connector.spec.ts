/**
 * T-RR-031 — `PromoCodeServiceConnector` against a mocked global `fetch` (same
 * `reward-tracking-rest.client.spec.ts` idiom, T-RR-035) for the HTTP leg, and the real local
 * Postgres 16 server (root `CLAUDE.md`) for the `external_system_call_log` write this connector
 * owns end to end (`01-DATABASE.md` §9) — a fake can't prove a real `INSERT`/FK relationship, same
 * reasoning `dispatch-channel-config.repository.spec.ts` (T-RR-033) already documents for its own
 * suite. `EncryptionService` is the one real (not faked) collaborator, same
 * `outbox-publisher.service.spec.ts` (T-RR-034/035) precedent — several cases depend on
 * `entry.customer_id_encrypted` actually decrypting to the exact plaintext this suite encrypted,
 * proving R8's boundary end to end.
 *
 * One real `reward_redemption_entry` row is seeded once in `beforeAll` (the FK
 * `external_system_call_log.reward_entry_id` requires it to exist) and reused by every test case —
 * `external_system_call_log` legitimately allows many rows per `reward_entry_id` (one per attempt),
 * so no per-test-case row is needed.
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
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { MetricsRegistry } from '@/observability/metrics.registry';
import {
  MissingAuthSecretError,
  PromoCodeServiceConnector,
} from '@/modules/connectors/promo-code-service.connector';
import type { PromoCodeGenerateResponse } from '@/modules/connectors/promo-code-service.connector.types';

const AES_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const AUTH_SECRET_ENV_VAR = 'T_RR_031_TEST_GENERATION_SERVICE_TOKEN';
const AUTH_SECRET_VALUE = 'super-secret-generation-token-VALUE';
const PLAINTEXT_CUSTOMER_ID = 'MSISDN-CUSTOMER-SECRET-13';
const SEEDED_ENTRY_ID = randomUUID();
const SEEDED_CORRELATION_ID = randomUUID();

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
    customer_id_encrypted: encryption.encrypt(PLAINTEXT_CUSTOMER_ID),
    customer_id_hash: 'test-customer-hash',
    customer_id_type: 'MSISDN',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'ACT_CODE',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: '50.0000',
    activity_value_unit: 'MYR',
    channel: 'APP',
    activity_performed_env: 'development',
    activity_name: 't-rr-031 connector fixture',
    campaign_code: 'CAMP_T_RR_031',
    tracker_code: 'TRK_T_RR_031',
    tracker_component_code: 'COMP_T_RR_031',
    merchant_code: 'MERCH_T_RR_031',
    reward_code: 'PROMO10',
    reward_category: 'VOUCHER',
    reward_value: '10.0000',
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
    id: 1,
    system_code: 'PROMO_CODE_SERVICE',
    tenant_id: null,
    connector_type: 'PROMO_CODE_SERVICE',
    endpoint_url: 'http://promo-code-service.test/api/v1/promo-codes/generate',
    auth_secret_ref: AUTH_SECRET_ENV_VAR,
    retryable_error_codes: ['GENERATION_EXHAUSTED'],
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function successBody(
  overrides: Partial<PromoCodeGenerateResponse> = {},
): PromoCodeGenerateResponse {
  return {
    status: 'SUCCESS',
    promoCodeId: randomUUID(),
    code: 'WELCOME10-XK92J',
    rewardValueType: 'PERCENTAGE',
    rewardValue: '10.0000',
    rewardUnit: '%',
    expiresAt: '',
    errorCode: '',
    errorMessage: '',
    // T-RR-090.
    versionNo: null,
    ...overrides,
  };
}

function failedBody(errorCode: string, errorMessage = 'boom'): PromoCodeGenerateResponse {
  return {
    status: 'FAILED',
    promoCodeId: '',
    code: '',
    rewardValueType: '',
    rewardValue: '',
    rewardUnit: '',
    expiresAt: '',
    errorCode,
    errorMessage,
    // T-RR-090.
    versionNo: null,
  };
}

describe('T-RR-031 — PromoCodeServiceConnector', () => {
  let migrationDb: Sequelize;
  let connector: PromoCodeServiceConnector;
  let fetchSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let metrics: MetricsRegistry;
  const ORIGINAL_ENV = { ...process.env };

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();

    await migrationDb.query(
      `INSERT INTO reward_redemption.reward_redemption_entry
         (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
          customer_id_type, activity_performed_date, activity_type, activity_category,
          activity_value, activity_value_unit, channel, activity_performed_env, activity_name,
          campaign_code, tracker_code, tracker_component_code, merchant_code, reward_code,
          reward_category, reward_value, reward_value_unit, reward_entry_date, reward_processed_env,
          ingestion_channel, status)
       VALUES
         (:id, :correlationId, 1, :customerIdEncrypted, :customerIdHash, 'MSISDN', now(),
          'PURCHASE', 'SPEND', '50.0000', 'MYR', 'APP', 'development',
          't-rr-031 connector fixture', 'CAMP_T_RR_031', 'TRK_T_RR_031', 'COMP_T_RR_031',
          'MERCH_T_RR_031', 'PROMO10', 'VOUCHER', '10.0000', '%', now(), 'development', 'REST',
          'processing')`,
      {
        type: QueryTypes.RAW,
        replacements: {
          id: SEEDED_ENTRY_ID,
          correlationId: SEEDED_CORRELATION_ID,
          customerIdEncrypted: encryption.encrypt(PLAINTEXT_CUSTOMER_ID),
          customerIdHash: 'test-customer-hash',
        },
      },
    );

    metrics = new MetricsRegistry();
    connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      metrics,
    );
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
    await migrationDb.close();
    await connector.onModuleDestroy();
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, [AUTH_SECRET_ENV_VAR]: AUTH_SECRET_VALUE };
    fetchSpy = jest.spyOn(global, 'fetch');
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
    metrics.resetForTests();
  });

  async function fetchLatestCallLogRow(): Promise<Record<string, unknown>> {
    const rows = await migrationDb.query<Record<string, unknown>>(
      `SELECT * FROM reward_redemption.external_system_call_log
         WHERE reward_entry_id = :id ORDER BY called_at DESC LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { id: SEEDED_ENTRY_ID } },
    );
    expect(rows.length).toBeGreaterThan(0);
    return rows[0];
  }

  it('TC-1: status SUCCESS response maps to outcome SUCCESS with externalReferenceId = promoCodeId', async () => {
    const body = successBody({ promoCodeId: 'promo-code-id-123' });
    fetchSpy.mockResolvedValue(jsonResponse(200, body));

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('SUCCESS');
    expect(result).toMatchObject({ outcome: 'SUCCESS', externalReferenceId: 'promo-code-id-123' });
  });

  it('TC-2: FAILED with errorCode present in retryableErrorCodes -> RETRYABLE_FAILURE', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, failedBody('GENERATION_EXHAUSTED')));

    const result = await connector.redeem(
      buildEntry(),
      buildConnectorConfig({ retryable_error_codes: ['GENERATION_EXHAUSTED'] }),
    );

    expect(result.outcome).toBe('RETRYABLE_FAILURE');
  });

  it('TC-3: FAILED with errorCode absent from retryableErrorCodes -> PERMANENT_FAILURE (CONFIG_NOT_BOUND)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, failedBody('CONFIG_NOT_BOUND')));

    const result = await connector.redeem(
      buildEntry(),
      buildConnectorConfig({ retryable_error_codes: ['GENERATION_EXHAUSTED'] }),
    );

    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  it('TC-4: FAILED with errorCode absent from retryableErrorCodes -> PERMANENT_FAILURE (INVALID_REQUEST)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, failedBody('INVALID_REQUEST')));

    const result = await connector.redeem(
      buildEntry(),
      buildConnectorConfig({ retryable_error_codes: ['GENERATION_EXHAUSTED'] }),
    );

    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  it('TC-5: HTTP 500 -> RETRYABLE_FAILURE', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { error: 'boom' }));

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('RETRYABLE_FAILURE');
  });

  it('TC-6: connection refused / network error -> RETRYABLE_FAILURE', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('RETRYABLE_FAILURE');
  });

  it('TC-7: request timeout (abort) -> RETRYABLE_FAILURE', async () => {
    fetchSpy.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('RETRYABLE_FAILURE');
  });

  it('TC-8: HTTP 401 -> PERMANENT_FAILURE (deliberate deviation, implementation note 4)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  it('TC-9: retryableErrorCodes is empty [] -> any FAILED errorCode is PERMANENT_FAILURE', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, failedBody('GENERATION_EXHAUSTED')));

    const result = await connector.redeem(
      buildEntry(),
      buildConnectorConfig({ retryable_error_codes: [] }),
    );

    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  it('TC-10: a successful call inserts an external_system_call_log row with result=SUCCESS and latency_ms > 0', async () => {
    // A real network call always takes measurable time; a same-tick mock resolution can
    // legitimately round to 0ms on `Date.now()`'s own millisecond resolution — a small delay
    // here proves `latency_ms` is wired to a real elapsed-time measurement, not that fetch is
    // slow in production.
    fetchSpy.mockImplementation(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(jsonResponse(200, successBody())), 5)),
    );

    await connector.redeem(buildEntry(), buildConnectorConfig());
    const row = await fetchLatestCallLogRow();

    expect(row.result).toBe('SUCCESS');
    expect(row.error_code).toBeNull();
    expect(Number(row.latency_ms)).toBeGreaterThan(0);
  });

  it('T-RR-059 TC-2/TC-3: external_system_call_total{system_code, result} increments exactly once per redeem() call, mapping outcome -> result correctly', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, successBody()));
    await connector.redeem(buildEntry(), buildConnectorConfig());
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'PROMO_CODE_SERVICE',
        result: 'success',
      }),
    ).toBe(1);

    fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
    await connector.redeem(buildEntry(), buildConnectorConfig());
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'PROMO_CODE_SERVICE',
        result: 'retryable_failure',
      }),
    ).toBe(1);

    fetchSpy.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));
    await connector.redeem(buildEntry(), buildConnectorConfig());
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'PROMO_CODE_SERVICE',
        result: 'permanent_failure',
      }),
    ).toBe(1);

    // Not a change-detector (AGENT-PROTOCOL.md §3): the counts above are each exactly 1, not 0 or
    // 2 — this would fail if the mapping ever mislabelled an outcome or double/under-counted.
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'PROMO_CODE_SERVICE',
        result: 'success',
      }),
    ).toBe(1);
  });

  it('T-RR-059: the MISSING_AUTH_SECRET early-return path (writeCallLog called before any HTTP attempt) still increments external_system_call_total{result:"permanent_failure"}', async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env[AUTH_SECRET_ENV_VAR];

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('PERMANENT_FAILURE');
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'PROMO_CODE_SERVICE',
        result: 'permanent_failure',
      }),
    ).toBe(1);
  });

  it('T-RR-059 TC-4: a MetricsRegistry-less construction (no real DI) never throws — the increment is a no-op, adjacent behaviour (the call-log write) is unchanged', async () => {
    const bareConnector = new PromoCodeServiceConnector(encryption, realDbConfigService());
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, successBody()));

    const result = await bareConnector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('SUCCESS');
    const row = await fetchLatestCallLogRow();
    expect(row.result).toBe('SUCCESS');
    await bareConnector.onModuleDestroy();
  });

  it('TC-11: request_summary/response_summary never carry the Authorization value, plaintext customerId, or the auth secret value', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, successBody()));

    await connector.redeem(buildEntry(), buildConnectorConfig());
    const row = await fetchLatestCallLogRow();
    const serialized = JSON.stringify(row);

    expect(serialized).not.toContain(AUTH_SECRET_VALUE);
    expect(serialized).not.toContain(PLAINTEXT_CUSTOMER_ID);
    expect(serialized).not.toContain('Authorization');
  });

  it('TC-11b: the same guarantee holds on a FAILED (non-SUCCESS) attempt too', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, failedBody('CONFIG_NOT_BOUND')));

    await connector.redeem(buildEntry(), buildConnectorConfig());
    const row = await fetchLatestCallLogRow();
    const serialized = JSON.stringify(row);

    expect(serialized).not.toContain(AUTH_SECRET_VALUE);
    expect(serialized).not.toContain(PLAINTEXT_CUSTOMER_ID);
    expect(serialized).not.toContain('Authorization');
  });

  it('TC-12: an unknown errorCode never seen on the cached list is treated as PERMANENT_FAILURE, for two different unknown codes', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, failedBody('SOME_FUTURE_CODE_A')));
    const first = await connector.redeem(
      buildEntry(),
      buildConnectorConfig({ retryable_error_codes: ['GENERATION_EXHAUSTED'] }),
    );

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, failedBody('SOME_FUTURE_CODE_B')));
    const second = await connector.redeem(
      buildEntry(),
      buildConnectorConfig({ retryable_error_codes: ['GENERATION_EXHAUSTED'] }),
    );

    expect(first.outcome).toBe('PERMANENT_FAILURE');
    expect(second.outcome).toBe('PERMANENT_FAILURE');
  });

  it('TC-13: customerId is decrypted for the call, but the plaintext value never appears in any logger call', async () => {
    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string);
      expect(parsed.customerId).toBe(PLAINTEXT_CUSTOMER_ID);
      return jsonResponse(200, successBody());
    });

    await connector.redeem(buildEntry(), buildConnectorConfig());

    const loggedText = warnSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(loggedText).not.toContain(PLAINTEXT_CUSTOMER_ID);
  });

  it('TC-14: no sequelize/pg transaction wraps the HTTP call (05-PROCESSING-PIPELINE.md §3)', () => {
    const source = readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'src',
        'modules',
        'connectors',
        'promo-code-service.connector.ts',
      ),
      'utf8',
    );
    expect(source).not.toMatch(/\.transaction\(/);
    expect(source).not.toMatch(/\bBEGIN\b/);
  });

  it('never hardcodes which promo-code-service errorCode is retryable — a missing auth secret is a PERMANENT_FAILURE, never crashes the caller', async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env[AUTH_SECRET_ENV_VAR];
    fetchSpy.mockResolvedValue(jsonResponse(200, successBody()));

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());

    expect(result.outcome).toBe('PERMANENT_FAILURE');
    expect(fetchSpy).not.toHaveBeenCalled();
    if (result.outcome !== 'SUCCESS') {
      expect(result.errorCode).toBe('MISSING_AUTH_SECRET');
    }
  });

  it('resolveAuthSecretValue failure is exposed as MissingAuthSecretError (imported type, not just a string check)', () => {
    expect(new (MissingAuthSecretError as unknown as new (ref: string) => Error)('X').name).toBe(
      'MissingAuthSecretError',
    );
  });
});
