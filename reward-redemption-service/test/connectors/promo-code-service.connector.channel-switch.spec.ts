/**
 * T-RR-080 — `PromoCodeServiceConnector`'s REST-vs-gRPC channel switch, exercised end to end
 * against the *real* local Postgres `reward_redemption.promo_code_channel_config` table (same
 * "a fake can't prove a real INSERT/row-resolution" reasoning `promo-code-service.connector.spec.ts`
 * documents for its own `external_system_call_log` suite, T-RR-031) and a real
 * `@grpc/grpc-js` mock promo-code-service server for the gRPC leg (same convention
 * `promo-code-service-grpc.client.spec.ts` establishes). Covers TC-1..TC-5 of T-RR-080's own task
 * file.
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
import { createMigrationConnection } from '@/database/migration-connection';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { PromoCodeServiceConnector } from '@/modules/connectors/promo-code-service.connector';
import { PromoCodeChannelResolverService } from '@/modules/connectors/promo-code-channel-resolver.service';
import { PromoCodeServiceGrpcClient } from '@/modules/connectors/promo-code-service-grpc.client';
import type { PromoCodeGenerateResponse } from '@/modules/connectors/promo-code-service.connector.types';

const AES_KEY_B64 = Buffer.alloc(32, 11).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 13).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const AUTH_SECRET_ENV_VAR = 'T_RR_080_TEST_GENERATION_SERVICE_TOKEN';
const AUTH_SECRET_VALUE = 'super-secret-generation-token-VALUE-080';
const PLAINTEXT_CUSTOMER_ID = 'MSISDN-CUSTOMER-SECRET-080';
const SEEDED_ENTRY_ID = randomUUID();
const SEEDED_CORRELATION_ID = randomUUID();

// Distinct campaign codes per test case — never reused across T-RR-080's own rows and never
// colliding with T-RR-031's own `CAMP_T_RR_031` fixture in the sibling spec file.
const CAMP_NO_ROW = 'CAMP_T_RR_080_NO_ROW';
const CAMP_GRPC_ENABLED = 'CAMP_T_RR_080_GRPC_ENABLED';
const CAMP_GRPC_MISCONFIGURED = 'CAMP_T_RR_080_GRPC_MISCONFIGURED';
const CAMP_GRPC_UNREACHABLE = 'CAMP_T_RR_080_GRPC_UNREACHABLE';
const CAMP_GRPC_FAILED = 'CAMP_T_RR_080_GRPC_FAILED';

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
    customer_id_hash: 'test-customer-hash-080',
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
    activity_name: 't-rr-080 channel-switch fixture',
    campaign_code: CAMP_NO_ROW,
    tracker_code: 'TRK_T_RR_080',
    tracker_component_code: 'COMP_T_RR_080',
    merchant_code: 'MERCH_T_RR_080',
    reward_code: 'PROMO10_080',
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

function restSuccessBody(): PromoCodeGenerateResponse {
  return {
    status: 'SUCCESS',
    promoCodeId: 'rest-promo-code-id',
    code: 'WELCOME10-REST',
    rewardValueType: 'PERCENTAGE',
    rewardValue: '10.0000',
    rewardUnit: '%',
    expiresAt: '',
    errorCode: '',
    errorMessage: '',
    // T-RR-090.
    versionNo: null,
  };
}

// -------------------------------------------------------------------------------------------
// Mock promo-code-service gRPC server, response driven by a mutable ref so each test case can
// reconfigure it without spinning up a fresh server per case.
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

let grpcServerResponse: PromoCodeGenerateResponse = {
  status: 'SUCCESS',
  promoCodeId: 'grpc-promo-code-id',
  code: 'WELCOME10-GRPC',
  rewardValueType: 'PERCENTAGE',
  rewardValue: '10.0000',
  rewardUnit: '%',
  expiresAt: '',
  errorCode: '',
  errorMessage: '',
  // T-RR-090: this is the raw proto message the mock server hands back (not yet through the
  // client's own null-translation) — proto3's own default for an unset string.
  versionNo: '',
};

function startMockGrpcServer(): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    const impl: grpc.UntypedServiceImplementation = {
      generateCode: (
        _call: grpc.ServerUnaryCall<unknown, PromoCodeGenerateResponse>,
        callback: grpc.sendUnaryData<PromoCodeGenerateResponse>,
      ) => {
        callback(null, grpcServerResponse);
      },
      listActivePromoCodeConfigs: (_call: unknown, callback: grpc.sendUnaryData<unknown>) => {
        callback({ name: 'Unimplemented', message: 'not used', code: grpc.status.UNIMPLEMENTED });
      },
    } as unknown as grpc.UntypedServiceImplementation;
    server.addService(loadServiceDefinition(), impl);
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port });
    });
  });
}

describe('T-RR-080 — PromoCodeServiceConnector, REST-vs-gRPC channel switch', () => {
  let migrationDb: Sequelize;
  let mockGrpcServer: grpc.Server;
  let mockGrpcPort: number;
  let workingGrpcClient: PromoCodeServiceGrpcClient;
  let unreachableGrpcClient: PromoCodeServiceGrpcClient;
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
          't-rr-080 channel-switch fixture', :campNoRow, 'TRK_T_RR_080', 'COMP_T_RR_080',
          'MERCH_T_RR_080', 'PROMO10_080', 'VOUCHER', '10.0000', '%', now(), 'development', 'REST',
          'processing')`,
      {
        type: QueryTypes.RAW,
        replacements: {
          id: SEEDED_ENTRY_ID,
          correlationId: SEEDED_CORRELATION_ID,
          customerIdEncrypted: encryption.encrypt(PLAINTEXT_CUSTOMER_ID),
          customerIdHash: 'test-customer-hash-080',
          campNoRow: CAMP_NO_ROW,
        },
      },
    );

    // TC-2: primary GRPC, enabled.
    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, true, 'GRPC', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_GRPC_ENABLED } },
    );
    // TC-3: primary GRPC, but grpc_enabled=false (misconfigured) — falls straight to REST.
    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, false, 'GRPC', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_GRPC_MISCONFIGURED } },
    );
    // TC-4: primary GRPC, enabled — but this test's own grpcClient points at an unreachable port.
    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, true, 'GRPC', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_GRPC_UNREACHABLE } },
    );
    // TC-5: primary GRPC, enabled — mock server returns a business FAILED.
    await migrationDb.query(
      `INSERT INTO reward_redemption.promo_code_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :code, NULL, true, true, 'GRPC', 'REST')`,
      { type: QueryTypes.RAW, replacements: { code: CAMP_GRPC_FAILED } },
    );

    ({ server: mockGrpcServer, port: mockGrpcPort } = await startMockGrpcServer());
    workingGrpcClient = new PromoCodeServiceGrpcClient({
      host: '127.0.0.1',
      port: mockGrpcPort,
      timeoutMs: 2_000,
    });
    // Port 1 is never a real listening promo-code-service in any test environment — a real,
    // deterministic connection-refused condition (same precedent
    // `promo-code-service-grpc.client.spec.ts`'s own TC-C establishes).
    unreachableGrpcClient = new PromoCodeServiceGrpcClient({
      host: '127.0.0.1',
      port: 1,
      timeoutMs: 1_000,
    });
    channelResolver = new PromoCodeChannelResolverService(realDbConfigService());
  });

  afterAll(async () => {
    for (const code of [
      CAMP_GRPC_ENABLED,
      CAMP_GRPC_MISCONFIGURED,
      CAMP_GRPC_UNREACHABLE,
      CAMP_GRPC_FAILED,
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
    workingGrpcClient.onModuleDestroy();
    unreachableGrpcClient.onModuleDestroy();
    await channelResolver.onModuleDestroy();
    await new Promise<void>((resolve) => mockGrpcServer.tryShutdown(() => resolve()));
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

  it('TC-1: no promo_code_channel_config row exists for this campaign except the seeded GLOBAL default -> resolves REST, identical to pre-T-RR-080 behavior', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, restSuccessBody()));
    const grpcSpy = jest.spyOn(workingGrpcClient, 'generateCode');
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      workingGrpcClient,
    );

    const result = await connector.redeem(
      buildEntry({ campaign_code: CAMP_NO_ROW }),
      buildConnectorConfig(),
    );

    expect(result.outcome).toBe('SUCCESS');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(grpcSpy).not.toHaveBeenCalled();
    grpcSpy.mockRestore();
    await connector.onModuleDestroy();
  });

  it('TC-2: a CAMPAIGN-level row with primary_channel=GRPC, grpc_enabled=true -> the connector calls the gRPC client, not REST', async () => {
    grpcServerResponse = {
      status: 'SUCCESS',
      promoCodeId: 'grpc-promo-code-id-tc2',
      code: 'WELCOME10-GRPC-TC2',
      rewardValueType: 'PERCENTAGE',
      rewardValue: '10.0000',
      rewardUnit: '%',
      expiresAt: '',
      errorCode: '',
      errorMessage: '',
      // T-RR-090.
      versionNo: '',
    };
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      workingGrpcClient,
    );

    const result = await connector.redeem(
      buildEntry({ campaign_code: CAMP_GRPC_ENABLED }),
      buildConnectorConfig(),
    );

    expect(result).toMatchObject({
      outcome: 'SUCCESS',
      externalReferenceId: 'grpc-promo-code-id-tc2',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await connector.onModuleDestroy();
  });

  it('TC-3: grpc_enabled=false but primary_channel=GRPC (misconfigured) -> treated as disabled, falls straight to REST', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, restSuccessBody()));
    const grpcSpy = jest.spyOn(workingGrpcClient, 'generateCode');
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      workingGrpcClient,
    );

    const result = await connector.redeem(
      buildEntry({ campaign_code: CAMP_GRPC_MISCONFIGURED }),
      buildConnectorConfig(),
    );

    expect(result).toMatchObject({ outcome: 'SUCCESS', externalReferenceId: 'rest-promo-code-id' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(grpcSpy).not.toHaveBeenCalled();
    grpcSpy.mockRestore();
    await connector.onModuleDestroy();
  });

  it('TC-4: gRPC call transport-unreachable -> falls back to REST within the same redeem() call, still resolves a proper RedemptionResult', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, restSuccessBody()));
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      unreachableGrpcClient,
    );

    const result = await connector.redeem(
      buildEntry({ campaign_code: CAMP_GRPC_UNREACHABLE }),
      buildConnectorConfig(),
    );

    expect(result).toMatchObject({ outcome: 'SUCCESS', externalReferenceId: 'rest-promo-code-id' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await connector.onModuleDestroy();
  });

  it("TC-5: gRPC call returns a business FAILED (CONFIG_INACTIVE) -> classified PERMANENT_FAILURE, identical mapping to the REST connector's own test for the same error code, no REST fallback attempted", async () => {
    grpcServerResponse = {
      status: 'FAILED',
      promoCodeId: '',
      code: '',
      rewardValueType: '',
      rewardValue: '',
      rewardUnit: '',
      expiresAt: '',
      errorCode: 'CONFIG_INACTIVE',
      errorMessage: 'binding is inactive',
      // T-RR-090.
      versionNo: '',
    };
    const connector = new PromoCodeServiceConnector(
      encryption,
      realDbConfigService(),
      undefined,
      undefined,
      channelResolver,
      workingGrpcClient,
    );

    const result = await connector.redeem(
      buildEntry({ campaign_code: CAMP_GRPC_FAILED }),
      buildConnectorConfig({ retryable_error_codes: ['GENERATION_EXHAUSTED'] }),
    );

    // Identical mapping to `promo-code-service.connector.spec.ts` TC-3 (REST, CONFIG_NOT_BOUND
    // not in retryable_error_codes -> PERMANENT_FAILURE) — same list-membership rule, same
    // outcome, for the same class of error code, over a different transport.
    expect(result.outcome).toBe('PERMANENT_FAILURE');
    if (result.outcome !== 'SUCCESS') {
      expect(result.errorCode).toBe('CONFIG_INACTIVE');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    await connector.onModuleDestroy();
  });
});
