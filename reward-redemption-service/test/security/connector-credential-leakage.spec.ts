/**
 * T-RR-042 — R9 connector-credential non-leakage audit (`AGENT-PROTOCOL.md` R9,
 * `reward-redemption-service-plan/tasks/T-RR-042-security-review.md` implementation note 3).
 *
 * Three layers, static then functional, independently re-verifying T-RR-031's own R8/R9
 * discipline rather than trusting that task's own suite alone (this task's own explicit
 * instruction):
 *
 * 1. **Static column-shape audit** — `external_reward_system_config`'s own row type
 *    (`ExternalRewardSystemConfigRow`) has exactly one auth-related column, `auth_secret_ref` (a
 *    *name*, never a value) — there is no `auth_secret_value`/`auth_token`/`password`-shaped
 *    column this connector could accidentally read a raw secret out of in the first place.
 * 2. **Functional: a real connector call never leaks the resolved secret value** —
 *    `PromoCodeServiceConnector.redeem()` against a real seeded row and a real
 *    `external_system_call_log` INSERT (same "a fake can't prove a real INSERT" reasoning
 *    `promo-code-service.connector.spec.ts` documents for its own suite), independently
 *    constructed and asserted here rather than re-run from that file.
 * 3. **Functional: the cache-invalidation admin endpoint's own response never echoes a secret** —
 *    `06-CACHING-AND-TENANT-CONFIG.md` §3's own explicit R9 callout, exercised against the real,
 *    fully-wired `AppModule` and real local Postgres, asserting the *outcome* (the actual HTTP
 *    response body, not a restated string) never contains any of this service's own real
 *    configured secret values.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { ConfigService } from '@nestjs/config';
import { AppModule } from '@/app.module';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { PromoCodeServiceConnector } from '@/modules/connectors/promo-code-service.connector';

describe('T-RR-042 — R9 external_reward_system_config column-shape audit (static)', () => {
  it('the model source declares exactly one auth-related field, auth_secret_ref, and no field named/shaped like a raw secret value', () => {
    const modelFile = path.join(
      __dirname,
      '..',
      '..',
      'src',
      'database',
      'models',
      'external-reward-system-config.model.ts',
    );
    const source = readFileSync(modelFile, 'utf8');
    // Every field declaration line inside the interface body, ignoring comments.
    const fieldLines = source
      .split('\n')
      .filter((l) => /^\s*\w+[?]?:\s/.test(l))
      .map((l) => l.trim());
    const authRelated = fieldLines.filter((l) => /auth|secret|token|password/i.test(l));
    expect(authRelated).toEqual(['auth_secret_ref: string;']);
  });
});

const AES_KEY_B64 = Buffer.alloc(32, 11).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 13).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const AUTH_SECRET_ENV_VAR = 'T_RR_042_AUDIT_GENERATION_SERVICE_TOKEN';
const AUTH_SECRET_VALUE = 'T-RR-042-independent-audit-secret-VALUE-do-not-leak';
const PLAINTEXT_CUSTOMER_ID = 'MSISDN-T-RR-042-AUDIT-CUSTOMER-2';
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

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: () => Promise.resolve(body) } as unknown as Response;
}

describe('T-RR-042 TC-4 — a real PromoCodeServiceConnector call never leaks the resolved secret value into external_system_call_log (independent re-check of T-RR-031)', () => {
  let migrationDb: Sequelize;
  let connector: PromoCodeServiceConnector;
  let fetchSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
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
          't-rr-042 audit fixture', 'CAMP_T_RR_042', 'TRK_T_RR_042', 'COMP_T_RR_042',
          'MERCH_T_RR_042', 'PROMO10', 'VOUCHER', '10.0000', '%', now(), 'development', 'REST',
          'processing')`,
      {
        type: QueryTypes.RAW,
        replacements: {
          id: SEEDED_ENTRY_ID,
          correlationId: SEEDED_CORRELATION_ID,
          customerIdEncrypted: encryption.encrypt(PLAINTEXT_CUSTOMER_ID),
          customerIdHash: 't-rr-042-audit-hash',
        },
      },
    );
    connector = new PromoCodeServiceConnector(encryption, realDbConfigService());
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
  });

  function buildEntry(): RewardRedemptionEntryRow {
    return {
      id: SEEDED_ENTRY_ID,
      correlation_id: SEEDED_CORRELATION_ID,
      tenant_id: 1,
      customer_id_encrypted: encryption.encrypt(PLAINTEXT_CUSTOMER_ID),
      customer_id_hash: 't-rr-042-audit-hash',
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
      activity_name: 't-rr-042 audit fixture',
      campaign_code: 'CAMP_T_RR_042',
      tracker_code: 'TRK_T_RR_042',
      tracker_component_code: 'COMP_T_RR_042',
      merchant_code: 'MERCH_T_RR_042',
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
    };
  }

  function buildConnectorConfig(): ExternalRewardSystemConfigRow {
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
    };
  }

  async function fetchLatestCallLogRow(): Promise<Record<string, unknown>> {
    const rows = await migrationDb.query<Record<string, unknown>>(
      `SELECT * FROM reward_redemption.external_system_call_log
       WHERE reward_entry_id = :id ORDER BY called_at DESC LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { id: SEEDED_ENTRY_ID } },
    );
    return rows[0];
  }

  it('TC-4: request_summary/response_summary/error_code never contain the resolved GENERATION_SERVICE_TOKEN value, the literal "Authorization", or the plaintext customerId', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        status: 'SUCCESS',
        promoCodeId: randomUUID(),
        code: 'WELCOME10-XK92J',
        rewardValueType: 'PERCENTAGE',
        rewardValue: '10.0000',
        rewardUnit: '%',
        expiresAt: '',
        errorCode: '',
        errorMessage: '',
      }),
    );

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());
    expect(result.outcome).toBe('SUCCESS');

    const row = await fetchLatestCallLogRow();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(AUTH_SECRET_VALUE);
    expect(serialized).not.toContain(PLAINTEXT_CUSTOMER_ID);
    expect(serialized).not.toContain('Authorization');

    const loggedText = warnSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(loggedText).not.toContain(AUTH_SECRET_VALUE);
    expect(loggedText).not.toContain(PLAINTEXT_CUSTOMER_ID);
  });

  it('TC-4b: the same guarantee holds when the auth secret itself is missing (PERMANENT_FAILURE path) — the error message names the env var, never a value', async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env[AUTH_SECRET_ENV_VAR];

    const result = await connector.redeem(buildEntry(), buildConnectorConfig());
    expect(result.outcome).toBe('PERMANENT_FAILURE');

    const row = await fetchLatestCallLogRow();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(AUTH_SECRET_VALUE);
    expect(serialized).toContain(AUTH_SECRET_ENV_VAR);
  });
});

describe('T-RR-042 TC-5 — POST /api/v1/cache/invalidate response never echoes any of this service’s real configured secret values', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const REAL_SECRET_ENV_VARS = [
    'CACHE_ADMIN_TOKEN',
    'REWARD_ENTRY_INGEST_TOKEN',
    'REWARD_TRACKING_REST_TOKEN',
    'GENERATION_SERVICE_TOKEN',
    'FIELD_ENCRYPTION_AES_KEY',
    'FIELD_ENCRYPTION_HMAC_KEY',
    'DB_APP_PASSWORD',
  ];

  it('TC-5: {"all": true} response body never contains any real configured secret value from process.env', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${process.env.CACHE_ADMIN_TOKEN}`)
      .send({ all: true });

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body);
    for (const envVar of REAL_SECRET_ENV_VARS) {
      const value = process.env[envVar];
      if (value && value.length > 0) {
        expect(serialized).not.toContain(value);
      }
    }
  });

  it('TC-5b: a malformed/unauthorized request’s error response also never contains a real secret value', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', 'Bearer wrong-token')
      .send({ all: true });

    expect(response.status).toBe(401);
    const serialized = JSON.stringify(response.body);
    for (const envVar of REAL_SECRET_ENV_VARS) {
      const value = process.env[envVar];
      if (value && value.length > 0) {
        expect(serialized).not.toContain(value);
      }
    }
  });
});
