/**
 * T-RR-041 — shared fixtures + real-pipeline test harness for every `test/e2e/*.e2e-spec.ts` file
 * this task owns (`full-pipeline`, `duplicate-arrival`, `direct-completion-no-connector`,
 * `permanent-failure`).
 *
 * Two kinds of exports live here, deliberately kept in one file rather than split further (the
 * task's own "Files owned" list names exactly this one fixtures file):
 *
 * 1. **Wire-level fixtures** (`buildCanonicalFixtureEntry`/`toGrpcRewardEntry`/
 *    `toKafkaMessageValue`/`toRestRequestBody`/the three `buildMalformed*` variants) — the same
 *    "one canonical fixture, three converters" shape `test/modules/reward-ingestion/fixtures/
 *    reward-entry.fixture.ts` (T-RR-014) already established, reimplemented here (not imported)
 *    so this task's own files never take on a hard dependency on another task's file staying
 *    byte-stable.
 * 2. **A real-pipeline harness** (`buildRealPipeline`) that constructs the same real, unmodified
 *    production classes `test/e2e/observability.e2e-spec.ts`'s own "T-RR-040 pass 2" describe
 *    block already proved is the correct, reviewed way to exercise claim -> resolve -> connector
 *    -> state-machine -> dispatch -> notification end to end without starting a real, unscoped
 *    `ClaimWorkerService`/`CompletionSweepService` polling loop that would race every other real-DB
 *    spec file in this repo sharing the same un-tenant-scoped `reward_redemption_entry` table
 *    (`T-RR-048`/`T-RR-052`/`T-RR-053`, all already-filed, already-known races). Only two
 *    boundaries are ever faked here, mirroring that same file's own header exactly:
 *    `RewardSystemResolutionService`/`ExternalRewardSystemConfigResolver` (portal-feed-caching, out
 *    of this task's scope) and nothing else — every connector, every dispatch tier, the state
 *    machine, the outbox, and notification are the real classes.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Client, Pool } from 'pg';
import { Sequelize, QueryTypes } from 'sequelize';
import type { ConfigService } from '@nestjs/config';
import type { Config } from '@/config/config.schema';
import { createMigrationConnection } from '@/database/migration-connection';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import type { RewardEntryProto } from '@/grpc/reward-ingest.grpc.types';
import type { IngestionChannel } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { RewardRedemptionEntryClaimRepository } from '@/modules/processing/reward-redemption-entry-claim.repository';
import { RedemptionProcessingOrchestrator } from '@/modules/processing/redemption-processing-orchestrator.service';
import type {
  ResolvedRewardSystem,
  TenantSchemaEnrichmentService,
} from '@/modules/processing/reward-system-resolution.service';
import { RetryClassificationService } from '@/modules/reward-system-config/retry-classification.service';
import { ConnectorRegistry } from '@/modules/connectors/connector-registry';
import { PromoCodeServiceConnector } from '@/modules/connectors/promo-code-service.connector';
import {
  CoreBankingConnector,
  CORE_BANKING_STUB_OUTCOME_CONFIG_KEY,
} from '@/modules/connectors/core-banking.connector';
import type { PromoCodeGenerateResponse } from '@/modules/connectors/promo-code-service.connector.types';
import { RedemptionStateMachineService } from '@/modules/redemption/redemption-state-machine.service';
import { RedemptionCompletionSideEffects } from '@/modules/redemption/redemption-completion-side-effects.port';
import { CompletionSweepService } from '@/modules/redemption/completion-sweep.service';
import { DispatchChannelResolverService } from '@/modules/dispatch/dispatch-channel-resolver.service';
import { DispatchChannelConfigRepository } from '@/modules/dispatch/dispatch-channel-config.repository';
import { DispatchChannelConfigCache } from '@/modules/dispatch/dispatch-channel-config.cache';
import { RewardTrackingOutboxRepository } from '@/modules/dispatch/reward-tracking-outbox.repository';
import { RewardTrackingDispatchRetryRepository } from '@/modules/dispatch/reward-tracking-dispatch-retry.repository';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import { DispatchMetricsService } from '@/modules/dispatch/dispatch-metrics.service';
import { RewardTrackingKafkaProducerClient } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import type { RewardTrackingKafkaProducerPort } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import { RewardTrackingRestClient } from '@/modules/dispatch/reward-tracking-rest.client';
import type { RewardTrackingRestClientPort } from '@/modules/dispatch/reward-tracking-rest.client';
import {
  NotificationService,
  type NotificationEnabledResolver,
} from '@/modules/notification/notification.service';
import { NotificationLogRepository } from '@/modules/notification/notification-log.repository';
import { NotificationMetricsService } from '@/modules/notification/notification-metrics.service';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import type { CampaignConfigCache } from '@/modules/processing/campaign-config.cache';
import { MetricsRegistry } from '@/observability/metrics.registry';

// ---------------------------------------------------------------------------------------------
// Generic test utilities
// ---------------------------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

/** Same ephemeral-port allocation idiom `cross-channel-parity.e2e-spec.ts` (T-RR-014) already
 * established for its own real gRPC server. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('failed to allocate a free port'));
      }
    });
  });
}

/** Same "read real process.env, allow scenario-specific overrides" idiom
 * `observability.e2e-spec.ts`'s own `realDbConfigService` already established. */
export function realDbConfigService(overrides: Partial<Config> = {}): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
    NODE_ENV: 'development',
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9094',
    ...overrides,
  };
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

// ---------------------------------------------------------------------------------------------
// Wire-level canonical fixture (mirrors T-RR-014's own "one canonical entry, three converters"
// shape — reimplemented here so this task never depends on that file staying byte-stable, per
// this file's own header).
// ---------------------------------------------------------------------------------------------

export interface CanonicalFixtureEntry {
  id: string;
  correlationId: string;
  tenantId: number;
  customerId: string;
  customerIdType: string;
  activityPerformedDate: string;
  transactionType: string | null;
  activityCode: string | null;
  activityType: string;
  activityCategory: string;
  activityValue: string;
  activityValueUnit: string;
  channel: string;
  activityPerformedEnv: string;
  activityName: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  merchantCode: string | null;
  rewardCode: string;
  rewardCategory: string;
  rewardValue: string;
  rewardValueUnit: string;
  rewardEntryDate: string;
  completionCycle: number;
}

export function buildCanonicalFixtureEntry(
  tenantId: number,
  overrides: Partial<CanonicalFixtureEntry> = {},
): CanonicalFixtureEntry {
  return {
    id: randomUUID(),
    correlationId: randomUUID(),
    tenantId,
    customerId: `cust-${randomUUID()}`,
    customerIdType: 'MSISDN',
    activityPerformedDate: '2026-09-04T10:15:00Z',
    transactionType: null,
    activityCode: 'TXN_TOPUP',
    activityType: 'TOPUP',
    activityCategory: 'TELCO',
    activityValue: '50.0000',
    activityValueUnit: 'MYR',
    channel: 'app',
    activityPerformedEnv: 'development',
    activityName: 'T-RR-041 full-pipeline fixture',
    campaignCode: `CAMP-TRR041-${randomUUID().slice(0, 8)}`,
    trackerCode: 'TRK-TRR041',
    trackerComponentCode: 'CMP-TRR041',
    merchantCode: 'MERCH-TRR041',
    rewardCode: 'RWD-TRR041',
    rewardCategory: 'CASHBACK',
    rewardValue: '2.5000',
    rewardValueUnit: 'MYR',
    rewardEntryDate: '2026-09-04T10:15:03Z',
    completionCycle: 1,
    ...overrides,
  };
}

export function toGrpcRewardEntry(fixture: CanonicalFixtureEntry): RewardEntryProto {
  return {
    id: fixture.id,
    correlationId: fixture.correlationId,
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    customerIdType: fixture.customerIdType,
    activityPerformedDate: fixture.activityPerformedDate,
    ...(fixture.transactionType !== null ? { transactionType: fixture.transactionType } : {}),
    ...(fixture.activityCode !== null ? { activityCode: fixture.activityCode } : {}),
    activityType: fixture.activityType,
    activityCategory: fixture.activityCategory,
    activityValue: fixture.activityValue,
    activityValueUnit: fixture.activityValueUnit,
    channel: fixture.channel,
    activityPerformedEnv: fixture.activityPerformedEnv,
    activityName: fixture.activityName,
    campaignCode: fixture.campaignCode,
    trackerCode: fixture.trackerCode,
    trackerComponentCode: fixture.trackerComponentCode,
    ...(fixture.merchantCode !== null ? { merchantCode: fixture.merchantCode } : {}),
    rewardCode: fixture.rewardCode,
    rewardCategory: fixture.rewardCategory,
    rewardValue: fixture.rewardValue,
    rewardValueUnit: fixture.rewardValueUnit,
    rewardEntryDate: fixture.rewardEntryDate,
    completionCycle: fixture.completionCycle,
  };
}

export function toKafkaMessageValue(fixture: CanonicalFixtureEntry): string {
  return JSON.stringify(fixture);
}

export function toRestRequestBody(fixture: CanonicalFixtureEntry): Record<string, unknown> {
  return { ...fixture };
}

/** TC-12 (REST leg): omits the mandatory `campaignCode` field entirely — mirrors
 * `reward-entries.e2e-spec.ts` TC-5's own "body missing campaignCode" case. */
export function buildMalformedRestBody(fixture: CanonicalFixtureEntry): Record<string, unknown> {
  const body = toRestRequestBody(fixture);
  delete body.campaignCode;
  return body;
}

/** TC-12 (gRPC leg): an empty `id` — mirrors `reward-ingest.e2e-spec.ts` TC-3's own case. */
export function buildMalformedGrpcEntry(fixture: CanonicalFixtureEntry): RewardEntryProto {
  return { ...toGrpcRewardEntry(fixture), id: '' };
}

/** TC-12 (Kafka leg): omits the mandatory `campaignCode` field — schema-invalid, DLQ-eligible
 * per `reward-entry-created.schema.ts`, never reaches `RewardIngestionService.ingest()` at all. */
export function buildMalformedKafkaMessageValue(fixture: CanonicalFixtureEntry): string {
  const body: Record<string, unknown> = { ...fixture };
  delete body.campaignCode;
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------------------------
// Connector-config / promo-code-service HTTP-mock fixtures
// ---------------------------------------------------------------------------------------------

export const PROMO_CODE_AUTH_SECRET_ENV_VAR = 'T_RR_041_PROMO_CODE_AUTH_TOKEN';
export const PROMO_CODE_AUTH_SECRET_VALUE = 'super-secret-t-rr-041-token';

export function buildPromoCodeConnectorConfig(
  overrides: Partial<ExternalRewardSystemConfigRow> = {},
): ExternalRewardSystemConfigRow {
  return {
    id: 1,
    system_code: 'PROMO_CODE_SERVICE',
    tenant_id: null,
    connector_type: 'PROMO_CODE_SERVICE',
    endpoint_url: 'http://promo-code-service.test/api/v1/promo-codes/generate',
    auth_secret_ref: PROMO_CODE_AUTH_SECRET_ENV_VAR,
    retryable_error_codes: ['GENERATION_EXHAUSTED'],
    max_retry_attempts: 5,
    retry_backoff_base_ms: 10,
    retry_backoff_max_ms: 50,
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    tenant_key: -1,
    ...overrides,
  };
}

export const CORE_BANKING_SYSTEM_CODE = 'CORE_BANKING';

export function buildCoreBankingConnectorConfig(
  overrides: Partial<ExternalRewardSystemConfigRow> = {},
): ExternalRewardSystemConfigRow {
  return {
    id: 2,
    system_code: CORE_BANKING_SYSTEM_CODE,
    tenant_id: null,
    connector_type: 'CORE_BANKING',
    endpoint_url: 'https://core-banking.internal/redeem',
    auth_secret_ref: 'secret-ref-placeholder',
    retryable_error_codes: ['CORE_BANKING_STUB_TIMEOUT'],
    max_retry_attempts: 2,
    retry_backoff_base_ms: 10,
    retry_backoff_max_ms: 50,
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    tenant_key: -1,
    ...overrides,
  };
}

/**
 * T-INT-049 addition: `bindLevel`/`bindRefId` default to a fixed, realistic-looking `CAMPAIGN`-level
 * numeric portal id (this harness fakes `RewardSystemResolutionService.resolve()` wholesale — this
 * file's own header — so there is no real `CampaignConfigProto.campaignId` to read here) rather than
 * left absent, so every caller of `buildRealPipeline` exercises the real, fixed T-INT-049 connector
 * behaviour (send the resolved numeric id) by default, not the pre-T-INT-049 fallback. `overrides`
 * lets a caller override any field, including these two, e.g. to exercise a `TRACKER`/`COMPONENT`
 * bind.
 */
export function buildResolvedReward(
  systemCode: string,
  overrides: Partial<ResolvedRewardSystem> = {},
): ResolvedRewardSystem {
  return {
    systemCode,
    rewardType: 'CASHBACK',
    deliveryMode: 'API',
    unitType: 'cashback',
    unitCode: 'TRR041_UNIT',
    level: 'campaign',
    refId: 0,
    bindLevel: 'CAMPAIGN',
    bindRefId: 529_444,
    versionNo: 1,
    status: 'active',
    ...overrides,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    // `RewardTrackingRestClient.dispatch()` checks `response.ok` (real `fetch`'s own derived
    // field, `status` in [200,300)) — `PromoCodeServiceConnector` checks `status` directly and
    // never reads `.ok`, so this only matters for REST-dispatch-tier scenarios, but must be
    // correct for both callers of this shared mock builder.
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

export function promoCodeSuccessBody(
  overrides: Partial<PromoCodeGenerateResponse> = {},
): PromoCodeGenerateResponse {
  return {
    status: 'SUCCESS',
    promoCodeId: randomUUID(),
    code: 'TRR041-WELCOME',
    rewardValueType: 'PERCENTAGE',
    rewardValue: '10.0000',
    rewardUnit: '%',
    expiresAt: '',
    errorCode: '',
    errorMessage: '',
    ...overrides,
  };
}

export function promoCodeFailedBody(
  errorCode: string,
  errorMessage = 'boom',
): PromoCodeGenerateResponse {
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
  };
}

// ---------------------------------------------------------------------------------------------
// DB helpers shared by every spec file in this task
// ---------------------------------------------------------------------------------------------

export function buildDbPool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: 20,
  });
}

export async function fetchRow(db: Sequelize, id: string): Promise<RewardRedemptionEntryRow> {
  const rows = await db.query<RewardRedemptionEntryRow>(
    'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = :id',
    { type: QueryTypes.SELECT, replacements: { id } },
  );
  if (rows.length !== 1) {
    throw new Error(`expected exactly one row for id ${id}, found ${rows.length}`);
  }
  return rows[0];
}

export async function countEntryRows(db: Sequelize, id: string): Promise<number> {
  const rows = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_entry WHERE id = :id',
    { type: QueryTypes.SELECT, replacements: { id } },
  );
  return Number(rows[0].count);
}

export async function countRelatedRows(
  db: Sequelize,
  table:
    | 'external_system_call_log'
    | 'reward_tracking_dispatch_outbox'
    | 'reward_tracking_dispatch_retry'
    | 'notification_log'
    | 'reward_redemption_failed',
  rewardEntryId: string,
): Promise<number> {
  const rows = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM reward_redemption.${table} WHERE reward_entry_id = :id`,
    { type: QueryTypes.SELECT, replacements: { id: rewardEntryId } },
  );
  return Number(rows[0].count);
}

/** T-RR-065 workaround — see `observability.e2e-spec.ts`'s own identical, already-reviewed
 * precedent for why this direct-SQL stamp stands in for the still-evolving claim-time enrichment
 * step rather than depending on it having fully landed. */
export async function stampTenantCountryEnrichment(db: Sequelize, id: string): Promise<void> {
  await db.query(
    `UPDATE reward_redemption.reward_redemption_entry
       SET tenant_code = 'TRR041', country_code = 'US'
     WHERE id = :id`,
    { type: QueryTypes.RAW, replacements: { id } },
  );
}

export async function backdatePastCompletionSweepGrace(db: Sequelize, id: string): Promise<void> {
  await db.query(
    `UPDATE reward_redemption.reward_redemption_entry
       SET updated_at = now() - interval '1 hour'
     WHERE id = :id`,
    { type: QueryTypes.RAW, replacements: { id } },
  );
}

/** Same "give back a foreign row" idiom `observability.e2e-spec.ts`/`T-RR-048` already establish
 * for the shared, un-tenant-scoped `reward_redemption_entry` claim query. */
export async function claimSpecificEntry(
  claimRepository: RewardRedemptionEntryClaimRepository,
  db: Sequelize,
  targetId: string,
  timeoutMs = 20_000,
): Promise<RewardRedemptionEntryRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const claimed = await claimRepository.claimNext();
    if (claimed && claimed.id === targetId) {
      return claimed;
    }
    if (claimed) {
      await db.query(
        `UPDATE reward_redemption.reward_redemption_entry
           SET status = 'received', updated_at = now(), created_at = now()
         WHERE id = :id`,
        { type: QueryTypes.RAW, replacements: { id: claimed.id } },
      );
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`claimSpecificEntry: "${targetId}" was not claimed within ${timeoutMs}ms`);
    }
    await sleep(15);
  }
}

/** Allows a `retrying` row scheduled with a real (small) backoff to become immediately
 * re-claimable, instead of waiting out `next_attempt_at` in real time. */
export async function forceNextAttemptNow(db: Sequelize, id: string): Promise<void> {
  await db.query(
    `UPDATE reward_redemption.reward_redemption_entry
       SET next_attempt_at = now() - interval '1 second'
     WHERE id = :id`,
    { type: QueryTypes.RAW, replacements: { id } },
  );
}

export async function cleanupEntry(db: Sequelize, id: string): Promise<void> {
  await db.query('DELETE FROM reward_redemption.notification_log WHERE reward_entry_id = :id', {
    type: QueryTypes.RAW,
    replacements: { id },
  });
  await db.query(
    'DELETE FROM reward_redemption.reward_tracking_dispatch_retry WHERE reward_entry_id = :id',
    { type: QueryTypes.RAW, replacements: { id } },
  );
  await db.query(
    'DELETE FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id = :id',
    { type: QueryTypes.RAW, replacements: { id } },
  );
  await db.query(
    'DELETE FROM reward_redemption.external_system_call_log WHERE reward_entry_id = :id',
    { type: QueryTypes.RAW, replacements: { id } },
  );
  await db.query(
    'DELETE FROM reward_redemption.reward_redemption_failed WHERE reward_entry_id = :id',
    { type: QueryTypes.RAW, replacements: { id } },
  );
  await db.query('DELETE FROM reward_redemption.reward_redemption_entry WHERE id = :id', {
    type: QueryTypes.RAW,
    replacements: { id },
  });
}

export async function insertServiceConfigOverride(
  db: Sequelize,
  key: string,
  scopeLevel: string,
  scopeRef: string,
  value: string,
): Promise<void> {
  await db.query(
    `INSERT INTO reward_redemption.service_config
       (config_key, scope_level, scope_ref, config_value, value_type)
     VALUES (:key, :scopeLevel, :scopeRef, :value, 'string')`,
    { type: QueryTypes.RAW, replacements: { key, scopeLevel, scopeRef, value } },
  );
}

export async function deleteServiceConfigOverride(
  db: Sequelize,
  key: string,
  scopeLevel: string,
  scopeRef: string,
): Promise<void> {
  await db.query(
    `DELETE FROM reward_redemption.service_config
       WHERE config_key = :key AND scope_level = :scopeLevel AND scope_ref = :scopeRef`,
    { type: QueryTypes.RAW, replacements: { key, scopeLevel, scopeRef } },
  );
}

export async function setCoreBankingStubOutcome(
  db: Sequelize,
  campaignCode: string,
  value: 'SUCCESS' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE',
): Promise<void> {
  await insertServiceConfigOverride(
    db,
    CORE_BANKING_STUB_OUTCOME_CONFIG_KEY,
    'CAMPAIGN',
    campaignCode,
    value,
  );
}

export async function clearCoreBankingStubOutcome(
  db: Sequelize,
  campaignCode: string,
): Promise<void> {
  await deleteServiceConfigOverride(
    db,
    CORE_BANKING_STUB_OUTCOME_CONFIG_KEY,
    'CAMPAIGN',
    campaignCode,
  );
}

/**
 * T-INT-001. `dispatch_channel_config`'s seeded `GLOBAL` row's own `primary_channel` no longer
 * defaults to `'KAFKA'` (migration `023`, `reward-service-integration-plan/ARCHITECTURE.md` §4 —
 * every `GLOBAL` row defaults to REST now). Any e2e test that means to exercise a *specific*
 * dispatch tier (its own title says so, e.g. "-> Kafka dispatch") must pin its own fixture's
 * `campaignCode` explicitly, the same "pin the transport actually under test" idiom
 * `reconciliation-poller-safety-net.spec.ts` already established — never rely on whatever the
 * ambient `GLOBAL` default happens to be. `DispatchChannelResolverService`'s own precedence walk
 * resolves CAMPAIGN before GLOBAL (`dispatch-channel-resolver.service.ts`), so a CAMPAIGN-scoped
 * row here always wins regardless of the GLOBAL row's own value.
 */
export async function setDispatchChannelPrimary(
  db: Sequelize,
  campaignCode: string,
  primaryChannel: 'REST' | 'GRPC' | 'KAFKA',
): Promise<void> {
  await db.query(
    `INSERT INTO reward_redemption.dispatch_channel_config
       (scope_level, scope_ref_code, tenant_id, kafka_enabled, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
     VALUES ('CAMPAIGN', :campaignCode, NULL, true, true, true, :primaryChannel, 'REST')`,
    { type: QueryTypes.RAW, replacements: { campaignCode, primaryChannel } },
  );
}

export async function clearDispatchChannelPrimary(
  db: Sequelize,
  campaignCode: string,
): Promise<void> {
  await db.query(
    `DELETE FROM reward_redemption.dispatch_channel_config
       WHERE scope_level = 'CAMPAIGN' AND scope_ref_code = :campaignCode`,
    { type: QueryTypes.RAW, replacements: { campaignCode } },
  );
}

/** `test/processing/fixtures/concurrent-workers.harness.ts`'s own shared mutex key, read (not
 * imported — that file is `agent-rr-processing`'s own file scope, R3) so every real-claim spec
 * file in this repo, this task's own included, serializes claim activity against the same
 * shared, un-tenant-scoped table rather than racing it (T-RR-048's own precedent). Duplicated as
 * a literal, not imported, so this task never depends on that file's own exports staying stable —
 * the numeric value itself is the actual shared contract (a Postgres advisory-lock key), not the
 * TypeScript binding. */
export const CROSS_FILE_CLAIM_TEST_MUTEX_KEY = 52_020_021;

export async function acquireCrossFileClaimMutex(): Promise<Client> {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
  });
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1::bigint)', [CROSS_FILE_CLAIM_TEST_MUTEX_KEY]);
  return client;
}

export async function releaseCrossFileClaimMutex(client: Client): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1::bigint)', [CROSS_FILE_CLAIM_TEST_MUTEX_KEY]);
  await client.end();
}

export function createMigrationDb(): Sequelize {
  return createMigrationConnection();
}

// ---------------------------------------------------------------------------------------------
// Real-pipeline harness — every class below is the real, unmodified production class
// (this file's own header).
// ---------------------------------------------------------------------------------------------

export interface RealPipelineOptions {
  /** The `system_code` `RewardSystemResolutionService` (faked, see this file's own header)
   * resolves this entry's reward to. */
  systemCode: string;
  /** The `external_reward_system_config` row `ExternalRewardSystemConfigResolver` (faked)
   * resolves for that `system_code` — `null` reproduces "no active connector config", the direct
   * `-> completed` path (TC-6). */
  connectorConfig: ExternalRewardSystemConfigRow | null;
  notificationsEnabled: boolean;
  sharedPool: Pool;
  /** Defaults to a real `RewardTrackingKafkaProducerClient` against `KAFKA_BROKERS`. Pass an
   * override (e.g. pointed at an unreachable broker, or a jest mock) for TC-9's Kafka-unavailable
   * scenario. */
  kafkaProducer?: RewardTrackingKafkaProducerPort;
  /** Defaults to a real `RewardTrackingRestClient` (its own `fetch` call is mocked at the global
   * `fetch` boundary by the caller, never this port itself). */
  restClient?: RewardTrackingRestClientPort;
  /**
   * T-RR-043 addition. Left `undefined` by every existing caller of this function (T-RR-041's own
   * four spec files, which all pre-stamp `tenant_code`/`country_code` via
   * `stampTenantCountryEnrichment` before ever calling `orchestrator.processClaimedEntry`, so the
   * orchestrator's own `@Optional()` fallback — never touching this dependency at all for an
   * already-enriched row — is exactly what they rely on, unchanged by this addition). This task's
   * own load test is the first caller that drives a real, continuously-polling `ClaimWorkerService`
   * concurrently with ingestion, which makes a pre-stamp-then-claim race real (a row can be claimed
   * before this task's own ingestion-side stamp lands) — passing a real
   * `TenantSchemaEnrichmentService` here instead closes that race by making enrichment happen for
   * real, at claim time, exactly as `06-CACHING-AND-TENANT-CONFIG.md` §5 specifies, rather than
   * depending on winning a race against the same background loop this task's own scope requires
   * running unmodified.
   */
  tenantSchemaEnrichment?: TenantSchemaEnrichmentService;
}

export interface RealPipelineHandles {
  metrics: MetricsRegistry;
  dispatchMetrics: DispatchMetricsService;
  notificationMetrics: NotificationMetricsService;
  serviceConfigResolver: ServiceConfigResolverService;
  orchestrator: RedemptionProcessingOrchestrator;
  stateMachine: RedemptionStateMachineService;
  completionSweep: CompletionSweepService;
  outboxPublisher: OutboxPublisherService;
  outboxRepository: RewardTrackingOutboxRepository;
  retryRepository: RewardTrackingDispatchRetryRepository;
  dispatchResolver: DispatchChannelResolverService;
  encryption: EncryptionService;
  /** The actual dispatch-tier client instances `outboxPublisher` was built against — exposed so a
   * caller that exercises the real Kafka tier (`options.kafkaProducer` left as the default real
   * `RewardTrackingKafkaProducerClient`) can close the real connection it opens via
   * `destroyRealPipeline` below, instead of leaking it past the test (`kafkajs`'s own connection
   * has no idle timeout of its own). A caller-supplied override (TC-9's unreachable-broker client)
   * is equally safe to pass through here — its own `onModuleDestroy()` is a no-op unless
   * `connect()` ever actually succeeded. */
  kafkaProducerClient: RewardTrackingKafkaProducerClient;
}

/** Best-effort teardown for the one real, non-shared-pool resource `buildRealPipeline` may open —
 * the real Kafka producer connection (never the DB-pool-backed repositories/services, which all
 * share the caller's own `sharedPool`, closed exactly once by the caller itself). Safe to call
 * even when the pipeline never actually published anything (an unopened `kafkajs` producer's own
 * `onModuleDestroy()` is a no-op). */
export async function destroyRealPipeline(handles: RealPipelineHandles): Promise<void> {
  await handles.kafkaProducerClient.onModuleDestroy();
}

/**
 * Builds one complete, fresh set of real production objects wired together exactly as
 * `RedemptionStateMachineModule`/`ClaimWorkerModule`'s own real Nest DI graph wires them
 * (`redemption-state-machine.module.ts`'s own header) — just constructed directly, the same
 * `observability.e2e-spec.ts` "T-RR-040 pass 2" precedent this file's own header cites, so this
 * task never starts a real, unscoped `CompletionSweepService`/`OutboxPublisherService` polling
 * loop (both are driven only via their own `sweepOnce()`/`runOnce()` below, never `onModuleInit`).
 */
export function buildRealPipeline(options: RealPipelineOptions): RealPipelineHandles {
  const { sharedPool } = options;
  const metrics = new MetricsRegistry();
  const dispatchMetrics = new DispatchMetricsService();
  const notificationMetrics = new NotificationMetricsService();
  const encryption = new EncryptionService(loadEncryptionKeyMaterial());

  const serviceConfigRepository = new ServiceConfigRepository(realDbConfigService(), sharedPool);
  const serviceConfigResolver = new ServiceConfigResolverService(serviceConfigRepository);

  const promoCodeConnector = new PromoCodeServiceConnector(
    encryption,
    realDbConfigService(),
    sharedPool,
    metrics,
  );
  const coreBankingConnector = new CoreBankingConnector(
    serviceConfigResolver,
    realDbConfigService(),
    sharedPool,
    metrics,
  );
  const connectorRegistry = new ConnectorRegistry();
  connectorRegistry.register('PROMO_CODE_SERVICE', promoCodeConnector);
  connectorRegistry.register('CORE_BANKING', coreBankingConnector);

  const dispatchChannelConfigRepository = new DispatchChannelConfigRepository(
    realDbConfigService(),
    sharedPool,
  );
  const dispatchResolver = new DispatchChannelResolverService(
    new DispatchChannelConfigCache(dispatchChannelConfigRepository, serviceConfigResolver),
  );
  const outboxRepository = new RewardTrackingOutboxRepository(realDbConfigService(), sharedPool);
  const retryRepository = new RewardTrackingDispatchRetryRepository(
    realDbConfigService(),
    sharedPool,
  );

  const fakeCampaignConfigCache = {
    get: async () => ({ trackers: [], rewards: [] }),
  } as unknown as CampaignConfigCache;
  const notificationResolver: NotificationEnabledResolver = () => options.notificationsEnabled;
  const notificationService = new NotificationService(
    fakeCampaignConfigCache,
    new NotificationLogRepository(realDbConfigService(), sharedPool),
    notificationMetrics,
    notificationResolver,
  );

  const sideEffects = new RedemptionCompletionSideEffects(
    dispatchResolver,
    outboxRepository,
    notificationService,
    realDbConfigService(),
    sharedPool,
  );
  const stateMachine = new RedemptionStateMachineService(
    realDbConfigService(),
    sideEffects,
    sharedPool,
  );

  const resolutionService = { resolve: async () => buildResolvedReward(options.systemCode) };
  const configResolver = { resolve: async () => options.connectorConfig };
  const orchestrator = new RedemptionProcessingOrchestrator(
    resolutionService as unknown as ConstructorParameters<
      typeof RedemptionProcessingOrchestrator
    >[0],
    configResolver as unknown as ConstructorParameters<typeof RedemptionProcessingOrchestrator>[1],
    new RetryClassificationService(),
    connectorRegistry,
    stateMachine,
    metrics,
    options.tenantSchemaEnrichment,
  );

  const completionSweep = new CompletionSweepService(
    stateMachine,
    serviceConfigResolver,
    metrics,
    realDbConfigService(),
    sharedPool,
  );

  const kafkaProducer =
    options.kafkaProducer ?? new RewardTrackingKafkaProducerClient(realDbConfigService());
  const restClient =
    options.restClient ??
    new RewardTrackingRestClient({
      baseUrl: 'http://reward-tracking-service.test',
      token: 'test-token',
      timeoutMs: 5_000,
    });

  const outboxPublisher = new OutboxPublisherService(
    outboxRepository,
    dispatchResolver,
    encryption,
    kafkaProducer as unknown as RewardTrackingKafkaProducerClient,
    dispatchMetrics,
    serviceConfigResolver,
    restClient as unknown as RewardTrackingRestClient,
    retryRepository,
    100,
    false,
  );

  return {
    metrics,
    dispatchMetrics,
    notificationMetrics,
    serviceConfigResolver,
    orchestrator,
    stateMachine,
    completionSweep,
    outboxPublisher,
    outboxRepository,
    retryRepository,
    dispatchResolver,
    encryption,
    kafkaProducerClient: kafkaProducer as unknown as RewardTrackingKafkaProducerClient,
  };
}

export function buildClaimRepository(sharedPool: Pool): RewardRedemptionEntryClaimRepository {
  return new RewardRedemptionEntryClaimRepository(realDbConfigService(), sharedPool);
}

export type { IngestionChannel };
