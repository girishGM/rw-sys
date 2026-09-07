/**
 * T-RR-090 — `PromoCodeServiceConnector` stamps the claimed entry's frozen
 * `promo_code_config_version_no` (`T-RR-062`) onto every `redeem()` request, on all three channels
 * (REST, gRPC via `T-RR-080`, Kafka via `T-RR-081` — both already `done` by the time this task
 * started, so this is the task that actually defines the shared `versionNo` field, per this task's
 * own "coordination note" header).
 *
 * The `reward_redemption_entry.promo_code_config_version_no` column only needs to exist on the row
 * this connector's own `external_system_call_log` write foreign-keys against (`01-DATABASE.md` §9)
 * — `redeem()` itself never re-reads the entry from the database, it only ever uses the
 * `ClaimedRewardEntry` object literal handed to it directly. One seeded row (reused across every
 * test case, same `T-RR-031`/`T-RR-080`/`T-RR-081` precedent) is therefore enough; the version under
 * test is varied purely via `buildEntry({ promo_code_config_version_no: ... })` overrides, never a
 * second DB row.
 *
 * REST/gRPC/Kafka channel selection still does need real `promo_code_channel_config` rows (same
 * `T-RR-080`/`T-RR-081` precedent) — this file seeds one campaign code per channel under test.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';

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
import { PromoCodeServiceGrpcClient } from '@/modules/connectors/promo-code-service-grpc.client';
import {
  PromoCodeServiceKafkaClient,
  type PromoCodeKafkaServiceConfigResolver,
} from '@/modules/connectors/promo-code-service-kafka.client';
import type { PromoCodeGenerateResponse } from '@/modules/connectors/promo-code-service.connector.types';

const AES_KEY_B64 = Buffer.alloc(32, 23).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 29).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const AUTH_SECRET_ENV_VAR = 'T_RR_090_TEST_GENERATION_SERVICE_TOKEN';
const AUTH_SECRET_VALUE = 'super-secret-generation-token-VALUE-090';
const PLAINTEXT_CUSTOMER_ID = 'MSISDN-CUSTOMER-SECRET-090';
const SEEDED_ENTRY_ID = randomUUID();
const SEEDED_CORRELATION_ID = randomUUID();

const CAMP_REST = 'CAMP_T_RR_090_REST';
const CAMP_GRPC = 'CAMP_T_RR_090_GRPC';
const CAMP_KAFKA = 'CAMP_T_RR_090_KAFKA';

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

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until the mocked Kafka producer's `send()` has actually been called, rather than a bare
 * fixed-delay `flush()` — this file opens more concurrent real-Postgres connections (one per
 * `PromoCodeChannelResolverService` across three `describe` blocks, plus a real mock gRPC server)
 * than `promo-code-service.connector.kafka-channel.spec.ts`'s own single-describe suite, so a fixed
 * 20ms window is not always enough for `requestAndAwaitReply`'s own `await` hops (timeout
 * resolution, then `connectProducer()`) to settle under that extra load. */
async function waitForProducerSend(timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mockProducerSend.mock.calls.length === 0) {
    if (Date.now() > deadline) {
      throw new Error(`waitForProducerSend: no producer.send() call within ${timeoutMs}ms`);
    }
    await flush(10);
  }
}

function buildEntry(overrides: Partial<RewardRedemptionEntryRow> = {}): RewardRedemptionEntryRow {
  return {
    id: SEEDED_ENTRY_ID,
    correlation_id: SEEDED_CORRELATION_ID,
    tenant_id: 1,
    customer_id_encrypted: encryption.encrypt(PLAINTEXT_CUSTOMER_ID),
    customer_id_hash: 'test-customer-hash-090',
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
    activity_name: 't-rr-090 version fixture',
    campaign_code: CAMP_REST,
    tracker_code: 'TRK_T_RR_090',
    tracker_component_code: 'COMP_T_RR_090',
    merchant_code: 'MERCH_T_RR_090',
    reward_code: 'PROMO10_090',
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
    versionNo: null,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// Mock promo-code-service gRPC server — captures every request it receives.
// -------------------------------------------------------------------------------------------

function protoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'promo_code_generation.proto');
}

function loadServiceDefinition(): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync(protoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    promocode: { v1: { PromoCodeService: { service: grpc.ServiceDefinition } } };
  };
  return proto.promocode.v1.PromoCodeService.service;
}

describe('T-RR-090 — PromoCodeServiceConnector, promoCodeConfigVersionNo pass-through', () => {
  let migrationDb: Sequelize;
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
          't-rr-090 version fixture', :campRest, 'TRK_T_RR_090', 'COMP_T_RR_090',
          'MERCH_T_RR_090', 'PROMO10_090', 'VOUCHER', '10.0000', '%', now(), 'development', 'REST',
          'processing')`,
      {
        type: QueryTypes.RAW,
        replacements: {
          id: SEEDED_ENTRY_ID,
          correlationId: SEEDED_CORRELATION_ID,
          customerIdEncrypted: encryption.encrypt(PLAINTEXT_CUSTOMER_ID),
          customerIdHash: 'test-customer-hash-090',
          campRest: CAMP_REST,
        },
      },
    );

    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, kafka_enabled,
          primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, true, false, 'GRPC', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_GRPC } },
    );
    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, kafka_enabled,
          primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, false, true, 'KAFKA', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_KAFKA } },
    );
  });

  afterAll(async () => {
    for (const code of [CAMP_GRPC, CAMP_KAFKA]) {
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

  async function fetchLatestCallLogRow(): Promise<Record<string, unknown>> {
    const rows = await migrationDb.query<Record<string, unknown>>(
      `SELECT * FROM reward_redemption.external_system_call_log
         WHERE reward_entry_id = :id ORDER BY called_at DESC LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { id: SEEDED_ENTRY_ID } },
    );
    expect(rows.length).toBeGreaterThan(0);
    return rows[0];
  }

  describe('REST channel', () => {
    // One shared connector for this whole `describe` block (same `T-RR-031` precedent) — a fresh
    // `new PromoCodeServiceConnector(...)` per test case would each open its own real `pg.Pool`
    // (this class's own constructor, no injected pool given) and never close it, leaking open
    // Postgres connections across the whole suite.
    let restConnector: PromoCodeServiceConnector;

    beforeAll(() => {
      restConnector = new PromoCodeServiceConnector(encryption, realDbConfigService());
    });

    afterAll(async () => {
      await restConnector.onModuleDestroy();
    });

    it('TC-1: an entry with promo_code_config_version_no set -> the request sent to promo-code-service carries that exact value', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, successBody()));

      await restConnector.redeem(
        buildEntry({ promo_code_config_version_no: 7 }),
        buildConnectorConfig(),
      );

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sentBody.versionNo).toBe('7');
    });

    it('TC-2: an entry with promo_code_config_version_no IS NULL (pre-T-RAP-062 data) -> the request omits the versionNo key entirely, no fabricated value', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, successBody()));

      await restConnector.redeem(
        buildEntry({ promo_code_config_version_no: null }),
        buildConnectorConfig(),
      );

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
      expect('versionNo' in sentBody).toBe(false);
    });

    it('an entry with promo_code_config_version_no undefined (predates the T-RR-062 column entirely) behaves identically to explicit null', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, successBody()));
      const entry = buildEntry();
      delete (entry as { promo_code_config_version_no?: number | null })
        .promo_code_config_version_no;

      await restConnector.redeem(entry, buildConnectorConfig());

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
      expect('versionNo' in sentBody).toBe(false);
    });

    it('TC-3: on a successful generation, external_system_call_log.request_summary includes the version passed, and response_summary includes the version promo-code-service echoed back', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, successBody({ versionNo: '7' })));

      await restConnector.redeem(
        buildEntry({ promo_code_config_version_no: 7 }),
        buildConnectorConfig(),
      );

      const row = await fetchLatestCallLogRow();
      const requestSummary = row.request_summary as Record<string, unknown>;
      const responseSummary = row.response_summary as Record<string, unknown>;
      expect(requestSummary.versionNo).toBe('7');
      expect(responseSummary.versionNo).toBe('7');
    });

    it('TC-4 (parity): the existing REST connector suite (T-RR-031) response-mapping/classification is unaffected by this field — a FAILED response with no version supplied still classifies purely off errorCode', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          status: 'FAILED',
          promoCodeId: '',
          code: '',
          rewardValueType: '',
          rewardValue: '',
          rewardUnit: '',
          expiresAt: '',
          errorCode: 'CONFIG_NOT_BOUND',
          errorMessage: 'not bound',
          versionNo: null,
        }),
      );

      const result = await restConnector.redeem(
        buildEntry({ promo_code_config_version_no: null }),
        buildConnectorConfig({ retryable_error_codes: ['GENERATION_EXHAUSTED'] }),
      );

      expect(result.outcome).toBe('PERMANENT_FAILURE');
    });
  });

  describe('gRPC channel (T-RR-080)', () => {
    let server: grpc.Server;
    let port: number;
    let generateCode: jest.Mock;
    let grpcClient: PromoCodeServiceGrpcClient;
    let channelResolver: PromoCodeChannelResolverService;

    beforeAll(async () => {
      generateCode = jest.fn(
        (
          call: grpc.ServerUnaryCall<{ versionNo: string }, PromoCodeGenerateResponse>,
          callback: grpc.sendUnaryData<PromoCodeGenerateResponse>,
        ) => {
          callback(null, {
            status: 'SUCCESS',
            promoCodeId: 'grpc-promo-code-id-090',
            code: 'WELCOME10-GRPC-090',
            rewardValueType: 'PERCENTAGE',
            rewardValue: '10.0000',
            rewardUnit: '%',
            expiresAt: '',
            errorCode: '',
            // Echoes back whatever version_no it received — proto3 empty string if none.
            errorMessage: '',
            versionNo: call.request.versionNo,
          });
        },
      );
      const impl: grpc.UntypedServiceImplementation = {
        generateCode,
        listActivePromoCodeConfigs: (_call: unknown, callback: grpc.sendUnaryData<unknown>) => {
          callback({ name: 'Unimplemented', message: 'not used', code: grpc.status.UNIMPLEMENTED });
        },
      } as unknown as grpc.UntypedServiceImplementation;
      server = new grpc.Server();
      server.addService(loadServiceDefinition(), impl);
      port = await new Promise<number>((resolve, reject) => {
        server.bindAsync(
          '127.0.0.1:0',
          grpc.ServerCredentials.createInsecure(),
          (error, boundPort) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(boundPort);
          },
        );
      });
      grpcClient = new PromoCodeServiceGrpcClient({ host: '127.0.0.1', port, timeoutMs: 2_000 });
      channelResolver = new PromoCodeChannelResolverService(realDbConfigService());
    });

    afterAll(async () => {
      grpcClient.onModuleDestroy();
      await channelResolver.onModuleDestroy();
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    });

    it('an explicit version is translated to the proto3 wire string and echoed back as the resolved responseSummary.versionNo', async () => {
      generateCode.mockClear();
      const connector = new PromoCodeServiceConnector(
        encryption,
        realDbConfigService(),
        undefined,
        undefined,
        channelResolver,
        grpcClient,
      );

      const result = await connector.redeem(
        buildEntry({ campaign_code: CAMP_GRPC, promo_code_config_version_no: 12 }),
        buildConnectorConfig(),
      );

      const sentRequest = generateCode.mock.calls[0][0].request as { versionNo: string };
      expect(sentRequest.versionNo).toBe('12');
      expect(result).toMatchObject({
        outcome: 'SUCCESS',
        responseSummary: expect.objectContaining({ versionNo: '12' }),
      });
      await connector.onModuleDestroy();
    });

    it("no version -> the wire carries proto3's own empty-string default, never a fabricated value, and the response translates back to null", async () => {
      generateCode.mockClear();
      const connector = new PromoCodeServiceConnector(
        encryption,
        realDbConfigService(),
        undefined,
        undefined,
        channelResolver,
        grpcClient,
      );

      const result = await connector.redeem(
        buildEntry({ campaign_code: CAMP_GRPC, promo_code_config_version_no: null }),
        buildConnectorConfig(),
      );

      const sentRequest = generateCode.mock.calls[0][0].request as { versionNo: string };
      expect(sentRequest.versionNo).toBe('');
      expect(result).toMatchObject({
        outcome: 'SUCCESS',
        responseSummary: expect.objectContaining({ versionNo: null }),
      });
      await connector.onModuleDestroy();
    });
  });

  describe('Kafka channel (T-RR-081)', () => {
    let channelResolver: PromoCodeChannelResolverService;

    beforeAll(() => {
      channelResolver = new PromoCodeChannelResolverService(realDbConfigService());
    });

    afterAll(async () => {
      await channelResolver.onModuleDestroy();
    });

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

    it('an explicit version is passed through untouched as the native JSON null-capable versionNo field, and the echoed response is captured', async () => {
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
        buildEntry({ campaign_code: CAMP_KAFKA, promo_code_config_version_no: 3 }),
        buildConnectorConfig(),
      );
      await waitForProducerSend();

      const lastCall = mockProducerSend.mock.calls[mockProducerSend.mock.calls.length - 1] as [
        { messages: Array<{ value: string }> },
      ];
      const envelope = JSON.parse(lastCall[0].messages[0].value) as {
        data: { versionNo: string | null };
      };
      expect(envelope.data.versionNo).toBe('3');

      replyToLastPublishedRequestWith(kafkaClient, {
        status: 'SUCCESS',
        promoCodeId: 'pc-mock-090',
        code: 'WELCOME10-KAFKA-090',
        rewardValueType: 'PERCENTAGE',
        rewardValue: '10.0000',
        rewardUnit: '%',
        expiresAt: '2026-12-01T00:00:00.000Z',
        errorCode: null,
        errorMessage: null,
        versionNo: '3',
      });

      const result = await resultPromise;
      expect(result).toMatchObject({
        outcome: 'SUCCESS',
        responseSummary: expect.objectContaining({ versionNo: '3' }),
      });
      await connector.onModuleDestroy();
    });

    it("no version -> the published envelope carries a literal JSON null, matching 02-KAFKA-CONTRACTS.md §3's own worked example, never a fabricated value", async () => {
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
        buildEntry({ campaign_code: CAMP_KAFKA, promo_code_config_version_no: null }),
        buildConnectorConfig(),
      );
      await waitForProducerSend();

      const lastCall = mockProducerSend.mock.calls[mockProducerSend.mock.calls.length - 1] as [
        { messages: Array<{ value: string }> },
      ];
      const envelope = JSON.parse(lastCall[0].messages[0].value) as {
        data: { versionNo: string | null };
      };
      expect(envelope.data.versionNo).toBeNull();

      replyToLastPublishedRequestWith(kafkaClient, {
        status: 'SUCCESS',
        promoCodeId: 'pc-mock-090-b',
        code: 'WELCOME10-KAFKA-090-B',
        rewardValueType: 'PERCENTAGE',
        rewardValue: '10.0000',
        rewardUnit: '%',
        expiresAt: '2026-12-01T00:00:00.000Z',
        errorCode: null,
        errorMessage: null,
        versionNo: null,
      });

      const result = await resultPromise;
      expect(result).toMatchObject({ outcome: 'SUCCESS' });
      await connector.onModuleDestroy();
    });
  });
});
