/**
 * T-RR-081 — `PromoCodeServiceConnector`'s Kafka channel, exercised end to end against the *real*
 * local Postgres `reward_redemption.promo_code_channel_config` table (same "a fake can't prove a
 * real INSERT/row-resolution" reasoning `promo-code-service.connector.channel-switch.spec.ts`
 * documents for its own T-RR-080 suite) with a *real* `PromoCodeServiceKafkaClient` instance whose
 * own `kafkajs` boundary is mocked (same "a shared, fixed consumer group is a real-broker testing
 * hazard, not a property to prove against a live socket" reasoning
 * `promo-code-service-kafka.client.spec.ts`'s own header documents) — this file's own test doubles
 * for promo-code-service's request consumer/result producer call `handleResultMessage()` directly
 * instead of round-tripping bytes over an actual broker connection, exactly the "faithfully
 * stubbed ... pair" this task's own Verification step 3 explicitly allows in place of a second,
 * real running service. Covers TC-4/TC-5 of T-RR-081's own task file, plus the
 * timeout-never-races-a-fallback and publish-failure-does-fall-back properties the tier-selection
 * algorithm requires.
 *
 * A new file, not an edit to `promo-code-service.connector.channel-switch.spec.ts` (T-RR-080's own
 * file) — same "this task adds its own new spec file rather than editing a sibling task's" pattern
 * T-RR-080 itself set relative to T-RR-031's `promo-code-service.connector.spec.ts`.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { ConfigService } from '@nestjs/config';

const mockProducerConnect = jest.fn().mockResolvedValue(undefined);
const mockProducerSend = jest.fn().mockResolvedValue(undefined);
const mockProducerDisconnect = jest.fn().mockResolvedValue(undefined);

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: () => ({
      connect: mockProducerConnect,
      send: mockProducerSend,
      disconnect: mockProducerDisconnect,
    }),
  })),
  logLevel: { NOTHING: 0 },
}));

import { createMigrationConnection } from '@/database/migration-connection';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { PromoCodeServiceConnector } from '@/modules/connectors/promo-code-service.connector';
import { PromoCodeChannelResolverService } from '@/modules/connectors/promo-code-channel-resolver.service';
import {
  PromoCodeServiceKafkaClient,
  type PromoCodeKafkaServiceConfigResolver,
} from '@/modules/connectors/promo-code-service-kafka.client';

const AES_KEY_B64 = Buffer.alloc(32, 17).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 19).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const AUTH_SECRET_ENV_VAR = 'T_RR_081_TEST_GENERATION_SERVICE_TOKEN';
const AUTH_SECRET_VALUE = 'super-secret-generation-token-VALUE-081';
const PLAINTEXT_CUSTOMER_ID = 'MSISDN-CUSTOMER-SECRET-081';
const SEEDED_ENTRY_ID = randomUUID();
const SEEDED_CORRELATION_ID = randomUUID();

const CAMP_KAFKA_DISABLED = 'CAMP_T_RR_081_KAFKA_DISABLED';
const CAMP_KAFKA_ENABLED = 'CAMP_T_RR_081_KAFKA_ENABLED';
const CAMP_KAFKA_TIMEOUT = 'CAMP_T_RR_081_KAFKA_TIMEOUT';
const CAMP_KAFKA_PUBLISH_FAILURE = 'CAMP_T_RR_081_KAFKA_PUBLISH_FAILURE';

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

function kafkaConfigService(): ConfigService<Config, true> {
  return { get: () => 'localhost:9094' } as unknown as ConfigService<Config, true>;
}

function fixedTimeoutResolver(timeoutMs: number): PromoCodeKafkaServiceConfigResolver {
  return { resolve: jest.fn().mockResolvedValue(timeoutMs) };
}

/** Enough real ticks for every `await` hop inside `requestAndAwaitReply` (mocked producer resolves
 * instantly) to settle, so the pending registry entry is guaranteed to exist before this test
 * drives `handleResultMessage` itself — same helper/reasoning as this file's sibling
 * `promo-code-service-kafka.client.spec.ts`. */
function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildEntry(overrides: Partial<RewardRedemptionEntryRow> = {}): RewardRedemptionEntryRow {
  return {
    id: SEEDED_ENTRY_ID,
    correlation_id: SEEDED_CORRELATION_ID,
    tenant_id: 1,
    customer_id_encrypted: encryption.encrypt(PLAINTEXT_CUSTOMER_ID),
    customer_id_hash: 'test-customer-hash-081',
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
    activity_name: 't-rr-081 kafka-channel fixture',
    campaign_code: CAMP_KAFKA_DISABLED,
    tracker_code: 'TRK_T_RR_081',
    tracker_component_code: 'COMP_T_RR_081',
    merchant_code: 'MERCH_T_RR_081',
    reward_code: 'PROMO10_081',
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
  return { status, json: () => Promise.resolve(body) } as unknown as Response;
}

/** Simulates promo-code-service's own request consumer / result producer for exactly one
 * matching request — reads the envelope this test's own `PromoCodeServiceKafkaClient` "published"
 * (captured via the mocked producer's `send`) and drives `handleResultMessage` directly with the
 * given result `data`, envelope-wrapped — this file's own header explains why this replaces a real
 * second broker round trip. */
function replyToLastPublishedRequestWith(
  kafkaClient: PromoCodeServiceKafkaClient,
  data: Record<string, unknown>,
): void {
  const lastCall = mockProducerSend.mock.calls[mockProducerSend.mock.calls.length - 1] as [
    { messages: Array<{ value: string }> },
  ];
  const envelope = JSON.parse(lastCall[0].messages[0].value) as { correlationId: string };
  kafkaClient.handleResultMessage(
    JSON.stringify({
      eventId: randomUUID(),
      correlationId: envelope.correlationId,
      tenantId: '1',
      source: 'promo-code-service',
      data,
    }),
  );
}

describe('T-RR-081 — PromoCodeServiceConnector, Kafka channel', () => {
  let migrationDb: Sequelize;
  let channelResolver: PromoCodeChannelResolverService;
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
          't-rr-081 kafka-channel fixture', :campKafkaDisabled, 'TRK_T_RR_081', 'COMP_T_RR_081',
          'MERCH_T_RR_081', 'PROMO10_081', 'VOUCHER', '10.0000', '%', now(), 'development', 'REST',
          'processing')`,
      {
        type: QueryTypes.RAW,
        replacements: {
          id: SEEDED_ENTRY_ID,
          correlationId: SEEDED_CORRELATION_ID,
          customerIdEncrypted: encryption.encrypt(PLAINTEXT_CUSTOMER_ID),
          customerIdHash: 'test-customer-hash-081',
          campKafkaDisabled: CAMP_KAFKA_DISABLED,
        },
      },
    );

    // TC-4: primary KAFKA, but kafka_enabled=false (misconfigured) — falls straight to REST.
    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, kafka_enabled,
          primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, false, false, 'KAFKA', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_KAFKA_DISABLED } },
    );
    // TC-5: primary KAFKA, enabled — full round trip.
    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, kafka_enabled,
          primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, false, true, 'KAFKA', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_KAFKA_ENABLED } },
    );
    // Timeout case: primary KAFKA, enabled — nobody ever replies.
    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, kafka_enabled,
          primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, false, true, 'KAFKA', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_KAFKA_TIMEOUT } },
    );
    // Publish-failure case: primary KAFKA, enabled — this test's own kafkaClient's producer
    // connect fails.
    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, kafka_enabled,
          primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, false, true, 'KAFKA', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_KAFKA_PUBLISH_FAILURE } },
    );

    channelResolver = new PromoCodeChannelResolverService(realDbConfigService());
  });

  afterAll(async () => {
    for (const code of [
      CAMP_KAFKA_DISABLED,
      CAMP_KAFKA_ENABLED,
      CAMP_KAFKA_TIMEOUT,
      CAMP_KAFKA_PUBLISH_FAILURE,
    ]) {
      await migrationDb.query(
        `DELETE FROM reward_redemption.promo_code_channel_config WHERE scope_ref_code = :code`,
        { type: QueryTypes.RAW, replacements: { code } },
      );
    }
    await migrationDb.query(
      `DELETE FROM reward_redemption.external_system_call_log WHERE reward_entry_id = :id`,
      { type: QueryTypes.RAW, replacements: { id: SEEDED_ENTRY_ID } },
    );
    await migrationDb.query(
      `DELETE FROM reward_redemption.reward_redemption_entry WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id: SEEDED_ENTRY_ID } },
    );
    await migrationDb.close();
    await channelResolver.onModuleDestroy();
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, [AUTH_SECRET_ENV_VAR]: AUTH_SECRET_VALUE };
    fetchSpy = jest.spyOn(global, 'fetch');
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.clearAllMocks();
    mockProducerConnect.mockResolvedValue(undefined);
    mockProducerSend.mockResolvedValue(undefined);
    mockProducerDisconnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
  });

  it('TC-4: kafka_enabled=false but primary_channel=KAFKA (misconfigured) -> falls straight to REST, Kafka never attempted', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        status: 'SUCCESS',
        promoCodeId: 'rest-promo-code-id',
        code: 'WELCOME10-REST',
        rewardValueType: 'PERCENTAGE',
        rewardValue: '10.0000',
        rewardUnit: '%',
        expiresAt: '',
        errorCode: '',
        errorMessage: '',
      }),
    );
    const kafkaClient = new PromoCodeServiceKafkaClient(
      kafkaConfigService(),
      fixedTimeoutResolver(5_000),
    );
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      undefined,
      kafkaClient,
    );

    const result = await connector.redeem(
      buildEntry({ campaign_code: CAMP_KAFKA_DISABLED }),
      buildConnectorConfig(),
    );

    expect(result).toMatchObject({ outcome: 'SUCCESS', externalReferenceId: 'rest-promo-code-id' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockProducerSend).not.toHaveBeenCalled();
    await connector.onModuleDestroy();
  });

  it('TC-5: a CAMPAIGN-level row names KAFKA primary -> full round trip produces the same RedemptionResult shape REST/gRPC produce, REST never attempted', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, {}));
    const kafkaClient = new PromoCodeServiceKafkaClient(
      kafkaConfigService(),
      fixedTimeoutResolver(5_000),
    );
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      undefined,
      kafkaClient,
    );

    const resultPromise = connector.redeem(
      buildEntry({ campaign_code: CAMP_KAFKA_ENABLED }),
      buildConnectorConfig(),
    );
    await flush();
    replyToLastPublishedRequestWith(kafkaClient, {
      status: 'SUCCESS',
      promoCodeId: 'pc-mock-tc5',
      code: 'WELCOME10-KAFKA',
      rewardValueType: 'PERCENTAGE',
      rewardValue: '10.0000',
      rewardUnit: '%',
      expiresAt: '2026-12-01T00:00:00.000Z',
      errorCode: null,
      errorMessage: null,
    });

    const result = await resultPromise;
    expect(result).toEqual({
      outcome: 'SUCCESS',
      externalReferenceId: 'pc-mock-tc5',
      responseSummary: expect.objectContaining({ status: 'SUCCESS', code: 'WELCOME10-KAFKA' }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await connector.onModuleDestroy();
  });

  it('a business FAILED result over Kafka classifies identically to the REST/gRPC connectors for the same error code', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, {}));
    const kafkaClient = new PromoCodeServiceKafkaClient(
      kafkaConfigService(),
      fixedTimeoutResolver(5_000),
    );
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      undefined,
      kafkaClient,
    );

    const resultPromise = connector.redeem(
      buildEntry({ campaign_code: CAMP_KAFKA_ENABLED }),
      buildConnectorConfig({ retryable_error_codes: ['GENERATION_EXHAUSTED'] }),
    );
    await flush();
    replyToLastPublishedRequestWith(kafkaClient, {
      status: 'FAILED',
      promoCodeId: null,
      code: null,
      rewardValueType: null,
      rewardValue: null,
      rewardUnit: null,
      expiresAt: null,
      errorCode: 'CONFIG_INACTIVE',
      errorMessage: 'binding is inactive',
    });

    const result = await resultPromise;
    expect(result.outcome).toBe('PERMANENT_FAILURE');
    if (result.outcome !== 'SUCCESS') {
      expect(result.errorCode).toBe('CONFIG_INACTIVE');
    }
    await connector.onModuleDestroy();
  });

  it('a reply timeout classifies RETRYABLE_FAILURE/KAFKA_REPLY_TIMEOUT and never races a same-call REST fallback (implementation note 3)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    const kafkaClient = new PromoCodeServiceKafkaClient(
      kafkaConfigService(),
      fixedTimeoutResolver(50),
    );
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      undefined,
      kafkaClient,
    );

    const result = await connector.redeem(
      buildEntry({ campaign_code: CAMP_KAFKA_TIMEOUT }),
      buildConnectorConfig(),
    );

    expect(result).toMatchObject({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'KAFKA_REPLY_TIMEOUT',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await connector.onModuleDestroy();
  });

  it('a Kafka publish failure (producer connect rejects) falls back to REST within the same redeem() call, still resolves a proper RedemptionResult', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        status: 'SUCCESS',
        promoCodeId: 'rest-promo-code-id-fallback',
        code: 'WELCOME10-REST-FALLBACK',
        rewardValueType: 'PERCENTAGE',
        rewardValue: '10.0000',
        rewardUnit: '%',
        expiresAt: '',
        errorCode: '',
        errorMessage: '',
      }),
    );
    mockProducerConnect.mockRejectedValue(new Error('ECONNREFUSED'));
    const kafkaClient = new PromoCodeServiceKafkaClient(
      kafkaConfigService(),
      fixedTimeoutResolver(30_000),
    );
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      undefined,
      kafkaClient,
    );

    const result = await connector.redeem(
      buildEntry({ campaign_code: CAMP_KAFKA_PUBLISH_FAILURE }),
      buildConnectorConfig(),
    );

    expect(result).toMatchObject({
      outcome: 'SUCCESS',
      externalReferenceId: 'rest-promo-code-id-fallback',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await connector.onModuleDestroy();
  });
});
