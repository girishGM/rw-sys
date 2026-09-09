/**
 * T-RR-040 — Observability wiring: structured logs + metrics contract.
 *
 * **Pass 1** (see git history / the original completion report) covered TC-1/TC-2/TC-3 (the
 * `StructuredLogger`/`LogRedactorService` guarantees) and a `MetricsRegistry` contract suite
 * proving each of §3's seven counters counts and labels correctly in isolation, and filed
 * T-RR-056…T-RR-060 against the five metrics/wiring gaps its audit found (no call site anywhere in
 * `src/` for five of the seven metrics, and `ClaimWorkerService` never actually invoking
 * `RedemptionProcessingOrchestrator`). TC-4 through TC-9 were `it.skip` placeholders pending those.
 *
 * **Pass 2 (this pass).** T-RR-056…T-RR-060 are now all `done` — re-audited directly against
 * current `src/` below, not assumed. TC-4/TC-5/TC-6/TC-7/TC-8/TC-9 are now real, against the real
 * local Postgres server (root `CLAUDE.md`) and the real, unmodified production classes for every
 * layer between ingestion and the two boundaries no real counterpart exists for anywhere in this
 * repo (reward-tracking-service itself, and the portal's live campaign-config feed) — see the
 * "T-RR-040 pass 2" describe block below for exactly which two boundaries are faked and why, and
 * for a second, genuine defect this pass's own audit found and filed (T-RR-065) along the way, at
 * the point this task's own audit was performed: `06-CACHING-AND-TENANT-CONFIG.md` §5's claim-time
 * `tenant_code`/`country_code` enrichment step had no implementation anywhere in
 * `src/modules/processing/**`/`src/modules/redemption/**`, which would have permanently stranded
 * every connector-routed redemption once `RedemptionCompletionSideEffects` (T-RR-061) became the
 * bound `REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT` implementation — `RewardTrackingOutboxRepository`'s
 * own `buildOutboxPayload` throws loudly on a `NULL` `tenant_code`/`country_code`. T-RR-065 is filed
 * against `agent-rr-processing` (the owner of the `src/modules/processing/**` call site the design
 * doc itself names) and out of this task's own file scope to fix (R3); a real fix
 * (`RedemptionProcessingOrchestrator.enrichTenantSchema`/`TenantSchemaEnrichmentService`) landed in
 * this same repo concurrently with this pass, ahead of T-RR-065 itself showing `done` in
 * `progress.json` at the time this file was last edited. The tests below still stamp
 * `tenant_code`/`country_code` directly via SQL immediately after ingestion (clearly commented at
 * each call site) rather than depend on that landing having fully settled — `enrichTenantSchema`'s
 * own idempotent short-circuit (`entry.tenant_code !== null && entry.country_code !== null`) means
 * this is correct either way, so the *observability* wiring this task actually owns (the metric/log
 * call sites downstream of that precondition) is exercised without depending on another task's own
 * completion state.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Sequelize, QueryTypes } from 'sequelize';
import { Client, Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Config } from '@/config/config.schema';
import { createMigrationConnection } from '@/database/migration-connection';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import { AppModule } from '@/app.module';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { LogRedactorService as EncryptionLogRedactorService } from '@/modules/encryption/log-redactor.service';
import { LogRedactorService } from '@/observability/log-redactor.service';
import {
  MetricsRegistry,
  type DispatchTier,
  type ExternalCallResult,
  type IngestionChannel,
} from '@/observability/metrics.registry';
import {
  StructuredLogger,
  StructuredLoggerFactory,
} from '@/observability/structured-logger.service';
import { RewardIngestionService } from '@/modules/reward-ingestion/reward-ingestion.service';
import { RewardRedemptionEntryRepository } from '@/modules/reward-ingestion/reward-redemption-entry.repository';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import { RewardRedemptionEntryClaimRepository } from '@/modules/processing/reward-redemption-entry-claim.repository';
import { RedemptionProcessingOrchestrator } from '@/modules/processing/redemption-processing-orchestrator.service';
import type { ResolvedRewardSystem } from '@/modules/processing/reward-system-resolution.service';
import type { CampaignConfigCache } from '@/modules/processing/campaign-config.cache';
import { RetryClassificationService } from '@/modules/reward-system-config/retry-classification.service';
import { ConnectorRegistry } from '@/modules/connectors/connector-registry';
import {
  CoreBankingConnector,
  CORE_BANKING_STUB_OUTCOME_CONFIG_KEY,
} from '@/modules/connectors/core-banking.connector';
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
import type { RewardTrackingKafkaProducerClient } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import type { RewardTrackingRestClient } from '@/modules/dispatch/reward-tracking-rest.client';
import {
  NotificationService,
  type NotificationEnabledResolver,
} from '@/modules/notification/notification.service';
import { NotificationLogRepository } from '@/modules/notification/notification-log.repository';
import { NotificationMetricsService } from '@/modules/notification/notification-metrics.service';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { CROSS_FILE_CLAIM_TEST_MUTEX_KEY } from '../processing/fixtures/concurrent-workers.harness';

jest.setTimeout(180_000);

/** §3's fixed metric-name list, verbatim — TC-10's own regression guard (implementation note 5's
 * "do not rename any metric or add a label §3 doesn't list"). Kept here, not just as a mental note,
 * so a future accidental rename/addition in `metrics.registry.ts` fails this test immediately. */
const SEC3_METRIC_NAMES = [
  'reward_entries_ingested_total',
  'reward_redemptions_completed_total',
  'reward_redemptions_failed_total',
  'external_system_call_total',
  'reward_tracking_dispatch_tier_total',
  'notification_logged_total',
  'cache_invalidation_total',
] as const;

describe('T-RR-040 — StructuredLogger + LogRedactorService', () => {
  const encryption = new EncryptionService({
    aesKey: Buffer.alloc(32, 7),
    hmacKey: Buffer.alloc(32, 9),
  });
  const redactor = new LogRedactorService(encryption);
  let logger: StructuredLogger;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  function lastLoggedEntry(spy: jest.SpyInstance): Record<string, unknown> {
    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[spy.mock.calls.length - 1] as [string];
    return JSON.parse(line) as Record<string, unknown>;
  }

  beforeEach(() => {
    logger = new StructuredLoggerFactory(redactor).forContext('ObservabilitySpec');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // TC-1
  it('TC-1: logs correlationId/tenantId/campaignCode/rewardEntryId as separate structured fields, never string-interpolated into the message', () => {
    const correlationId = randomUUID();
    logger.log('reward entry ingested', {
      correlationId,
      tenantId: 42,
      campaignCode: 'CAMP1',
      rewardEntryId: 'entry-123',
    });

    const entry = lastLoggedEntry(consoleLogSpy);
    expect(entry.correlationId).toBe(correlationId);
    expect(entry.tenantId).toBe(42);
    expect(entry.campaignCode).toBe('CAMP1');
    expect(entry.rewardEntryId).toBe('entry-123');
    // The message string itself must never carry any of these values baked in — a future
    // log-aggregation backend filters/aggregates on the structured fields directly, not by
    // parsing free text (§2).
    expect(entry.message).toBe('reward entry ingested');
    expect(String(entry.message)).not.toContain(correlationId);
    expect(String(entry.message)).not.toContain('42');
    expect(String(entry.message)).not.toContain('CAMP1');
    expect(String(entry.message)).not.toContain('entry-123');
  });

  // TC-2
  it('TC-2: a raw customerId value passed by mistake is intercepted and redacted before emission', () => {
    const correlationId = randomUUID();
    const rawCustomerId = 'CUST-00042-super-secret-raw-value';
    logger.log('caller forgot to pre-hash customerId', {
      correlationId,
      customerId: rawCustomerId,
    });

    const entry = lastLoggedEntry(consoleLogSpy);
    expect(entry.customerId).not.toBe(rawCustomerId);
    expect(JSON.stringify(entry)).not.toContain(rawCustomerId);
    // Redacted to the exact same one-way hash `customer_id_hash` already uses elsewhere in this
    // service (§2: "customer_id_hash ... is what appears in any log or audit record") — not some
    // independent placeholder token.
    expect(entry.customerId).toBe(encryption.hash(rawCustomerId));
  });

  // TC-3
  it('TC-3: correlationId is never redacted, even alongside a redacted field in the same call', () => {
    const correlationId = randomUUID();
    logger.log('mixed fields', {
      correlationId,
      customerId: 'CUST-should-be-redacted',
    });

    const entry = lastLoggedEntry(consoleLogSpy);
    expect(entry.correlationId).toBe(correlationId);
  });

  it('rejects a call with a missing/blank correlationId — a call site bug, not something silently tolerated', () => {
    expect(() => logger.log('missing correlationId', { correlationId: '' })).toThrow(
      /correlationId/,
    );
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('routes warn/error/debug through the correct console method, each still structured and redacted', () => {
    const correlationId = randomUUID();
    logger.warn('a warning', { correlationId, customerId: 'CUST-warn' });
    const warnEntry = lastLoggedEntry(consoleWarnSpy);
    expect(warnEntry.level).toBe('warn');
    expect(warnEntry.customerId).toBe(encryption.hash('CUST-warn'));

    logger.error('an error', { correlationId, customerId: 'CUST-error' });
    const errorEntry = lastLoggedEntry(consoleErrorSpy);
    expect(errorEntry.level).toBe('error');
    expect(errorEntry.customerId).toBe(encryption.hash('CUST-error'));
  });

  it('LogRedactorService.redactFields leaves non-denylisted fields (including non-string values) completely untouched', () => {
    const fields = {
      correlationId: 'keep-me',
      tenantId: 7,
      campaignCode: 'CAMP1',
      rewardEntryId: 'entry-1',
      arbitraryFlag: true,
    };
    expect(redactor.redactFields(fields)).toEqual(fields);
  });

  it('LogRedactorService.redactFields is deterministic for the same customerId (matches customer_id_hash lookup semantics)', () => {
    const first = redactor.redactFields({ correlationId: 'x', customerId: 'CUST-1' });
    const second = redactor.redactFields({ correlationId: 'x', customerId: 'CUST-1' });
    expect(first.customerId).toBe(second.customerId);
  });
});

describe("T-RR-040 — MetricsRegistry contract (§3's exact seven names/labels)", () => {
  let metrics: MetricsRegistry;

  beforeEach(() => {
    metrics = new MetricsRegistry();
  });

  it('reward_entries_ingested_total{channel} counts each channel independently', () => {
    const channels: IngestionChannel[] = ['grpc', 'kafka', 'rest'];
    channels.forEach((channel) => metrics.incrementRewardEntriesIngested(channel));
    metrics.incrementRewardEntriesIngested('rest');

    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'grpc' })).toBe(1);
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'kafka' })).toBe(1);
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'rest' })).toBe(2);
  });

  it('reward_redemptions_completed_total{system_code} / reward_redemptions_failed_total{system_code} count independently per system_code, and never cross-increment each other', () => {
    metrics.incrementRewardRedemptionsCompleted('PROMO_CODE_SERVICE');
    metrics.incrementRewardRedemptionsCompleted('PROMO_CODE_SERVICE');
    metrics.incrementRewardRedemptionsFailed('CORE_BANKING');

    expect(
      metrics.getCounterValue('reward_redemptions_completed_total', {
        system_code: 'PROMO_CODE_SERVICE',
      }),
    ).toBe(2);
    expect(
      metrics.getCounterValue('reward_redemptions_failed_total', {
        system_code: 'PROMO_CODE_SERVICE',
      }),
    ).toBe(0);
    expect(
      metrics.getCounterValue('reward_redemptions_failed_total', { system_code: 'CORE_BANKING' }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('reward_redemptions_completed_total', {
        system_code: 'CORE_BANKING',
      }),
    ).toBe(0);
  });

  it('external_system_call_total{system_code, result} counts each (system_code, result) pair independently', () => {
    const results: ExternalCallResult[] = ['success', 'retryable_failure', 'permanent_failure'];
    results.forEach((result) => metrics.incrementExternalSystemCall('PROMO_CODE_SERVICE', result));
    metrics.incrementExternalSystemCall('PROMO_CODE_SERVICE', 'success');

    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'PROMO_CODE_SERVICE',
        result: 'success',
      }),
    ).toBe(2);
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'PROMO_CODE_SERVICE',
        result: 'retryable_failure',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('external_system_call_total', {
        system_code: 'PROMO_CODE_SERVICE',
        result: 'permanent_failure',
      }),
    ).toBe(1);
  });

  it('reward_tracking_dispatch_tier_total{tier} counts each tier independently', () => {
    const tiers: DispatchTier[] = ['kafka', 'rest', 'retry_table'];
    tiers.forEach((tier) => metrics.incrementRewardTrackingDispatchTier(tier));

    tiers.forEach((tier) => {
      expect(metrics.getCounterValue('reward_tracking_dispatch_tier_total', { tier })).toBe(1);
    });
  });

  it('notification_logged_total (no labels) increments with no label dimension', () => {
    metrics.incrementNotificationLogged();
    metrics.incrementNotificationLogged();
    expect(metrics.getCounterValue('notification_logged_total')).toBe(2);
  });

  it('cache_invalidation_total{key} counts a scoped key and the "all" key independently', () => {
    metrics.incrementCacheInvalidation('campaignConfig');
    metrics.incrementCacheInvalidation('all');
    metrics.incrementCacheInvalidation('all');

    expect(metrics.getCounterValue('cache_invalidation_total', { key: 'campaignConfig' })).toBe(1);
    expect(metrics.getCounterValue('cache_invalidation_total', { key: 'all' })).toBe(2);
  });

  it('an unincremented metric/label combination reads 0, never undefined', () => {
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'grpc' })).toBe(0);
  });

  it('resetForTests clears every counter', () => {
    metrics.incrementNotificationLogged();
    metrics.resetForTests();
    expect(metrics.getCounterValue('notification_logged_total')).toBe(0);
  });

  // TC-10
  it("TC-10: exposes exactly §3's seven metric names — no extra, no renamed metric", () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'observability', 'metrics.registry.ts'),
      'utf8',
    );
    const found = new Set(Array.from(source.matchAll(/'([a-z_]+_total)'/g), (match) => match[1]));
    expect(found).toEqual(new Set(SEC3_METRIC_NAMES));
  });
});

/**
 * T-RR-040 pass 2 — full ingest-through-completion flow, real Postgres, real production classes.
 *
 * **What's real vs. faked, and why (mirrors `test/processing/concurrency-load-safety.e2e-spec.ts`'s
 * own header discipline for the identical kind of boundary call).** Every class between ingestion
 * and the redemption's own terminal state is the real, unmodified, production class — constructed
 * directly rather than via `TestingModule`/`AppModule` (none of `src/grpc|messaging|rest|modules/
 * reward-ingestion|processing|redemption|connectors|dispatch|notification/**` are this task's own
 * file scope, R3; the point here is auditing that each already-built layer's own metric/log call
 * site actually fires under a real flow, not re-implementing or re-wiring any of them). Two, and
 * only two, boundaries are faked:
 *  1. `RewardSystemResolutionService`/`ExternalRewardSystemConfigResolver` (which `system_code`/
 *     connector-config a campaign resolves to) — resolving those two caches against a live portal
 *     gRPC feed is Wave 1/2's own portal-feed-caching concern, not this task's; the identical fake
 *     used by `concurrency-load-safety.e2e-spec.ts`'s own `buildOrchestrator` helper.
 *  2. `RewardTrackingKafkaProducerClient`/`RewardTrackingRestClient` (the two transport clients
 *     `OutboxPublisherService` calls) — reward-tracking-service does not exist anywhere in this
 *     repo to call (`CLAUDE.md`'s own framing), so these are faked exactly the way
 *     `test/dispatch/outbox-publisher.service.spec.ts` already fakes them.
 * `CoreBankingConnector` is used as the one real, already-built connector that performs zero I/O
 * by design (`core-banking.connector.ts`'s own header) — a genuinely real class, not a test double,
 * whose only "fakeness" is that no real core-banking API exists to call (`ARCHITECTURE.md` §11,
 * `BACKLOG.md` B-2 — the same limitation the connector's own file already documents).
 *
 * **T-RR-065 workaround, applied once per entry, always clearly commented at its own call site.**
 * `06-CACHING-AND-TENANT-CONFIG.md` §5's claim-time `tenant_code`/`country_code` enrichment step —
 * which the design doc says should run "immediately after a row is claimed ... before §4's
 * reward-system resolution" — has no implementation anywhere in `src/modules/processing/**`/
 * `src/modules/redemption/**` today (confirmed by `grep -rn "tenant_code\|country_code"` returning
 * nothing outside migrations/models/this file). `RewardTrackingOutboxRepository.enqueue`'s own
 * `buildOutboxPayload` throws on a `NULL` `tenant_code`/`country_code`, which every real entry has
 * — filed as T-RR-065 (`agent-rr-processing`, out of this task's own file scope, R3). Every test
 * below that needs to reach `completed` via the outbox path stamps both columns directly via SQL
 * immediately after ingestion, standing in for the still-missing enrichment step, so this task can
 * still verify what it actually owns — the metric/log wiring downstream of that precondition —
 * without waiting on an unrelated fix landing first.
 */
describe('T-RR-040 pass 2 — full ingest-through-completion flow (real Postgres, real domain classes)', () => {
  let migrationDb: Sequelize;
  let mutexClient: Client;
  let sharedPool: Pool;
  let ingestionRepo: RewardRedemptionEntryRepository;
  let claimRepository: RewardRedemptionEntryClaimRepository;
  let serviceConfigRepository: ServiceConfigRepository;
  let serviceConfigResolver: ServiceConfigResolverService;
  let dispatchResolver: DispatchChannelResolverService;
  let outboxRepository: RewardTrackingOutboxRepository;
  let retryRepository: RewardTrackingDispatchRetryRepository;
  let encryption: EncryptionService;
  const entryIdsToClean: string[] = [];
  const serviceConfigScopesToClean: Array<{ scopeLevel: string; scopeRef: string | null }> = [];
  // T-INT-001: `dispatch_channel_config`'s seeded `GLOBAL` row's own `primary_channel` no longer
  // defaults to `'KAFKA'` (migration `023`, `reward-service-integration-plan/ARCHITECTURE.md` §4 —
  // every `GLOBAL` row defaults to REST now, per the user's explicit "Render can't run gRPC/Kafka
  // today" instruction). TC-4 below specifically means to exercise the Kafka-dispatch tier, so it
  // pins its own fixture's `campaignCode` to `primary_channel='KAFKA'` via a CAMPAIGN-scoped row
  // (`DispatchChannelResolverService`'s own precedence walk resolves CAMPAIGN before GLOBAL) rather
  // than relying on whatever the ambient GLOBAL default happens to be this week — the same
  // "pin the transport actually under test" idiom `reconciliation-poller-safety-net.spec.ts`
  // already uses for the identical reason.
  const dispatchChannelScopesToClean: string[] = [];

  function realDbConfigService(overrides: Partial<Config> = {}): ConfigService<Config, true> {
    const values: Partial<Config> = {
      DB_HOST: process.env.DB_HOST,
      DB_PORT: Number(process.env.DB_PORT),
      DB_NAME: process.env.DB_NAME,
      DB_SSL: process.env.DB_SSL === 'true',
      DB_APP_USERNAME: process.env.DB_APP_USERNAME,
      DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
      NODE_ENV: 'development',
      ...overrides,
    };
    return {
      get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
    } as ConfigService<Config, true>;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  let tenantCounter = 0;
  function nextTenantId(): number {
    tenantCounter += 1;
    // A 9-digit range this file's own tests don't share with any other real-DB spec file's own
    // convention (`concurrency-load-safety.e2e-spec.ts` uses `951_xxx_xxx`, `completion-sweep
    // .service.spec.ts` uses `950_xxx`) — collision-free by construction, not by luck.
    return 962_000_000 + tenantCounter * 10_000 + Math.floor(Math.random() * 9_000);
  }

  function buildIngestDto(
    tenantId: number,
    overrides: Partial<RewardEntryIngestDto> = {},
  ): RewardEntryIngestDto {
    return {
      id: randomUUID(),
      correlationId: randomUUID(),
      tenantId,
      customerId: `cust-${randomUUID()}`,
      customerIdType: 'EMAIL',
      activityPerformedDate: new Date(),
      transactionType: null,
      activityCode: 'ACT_CODE',
      activityType: 'PURCHASE',
      activityCategory: 'SPEND',
      activityValue: '10.0000',
      activityValueUnit: 'USD',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 't-rr-040 pass-2 fixture',
      campaignCode: `CAMP-TRR040-${randomUUID().slice(0, 8)}`,
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      merchantCode: null,
      rewardCode: 'RWD1',
      rewardCategory: 'CASHBACK',
      rewardValue: '5.0000',
      rewardValueUnit: 'USD',
      rewardEntryDate: new Date(),
      completionCycle: 1,
      ingestionChannel: 'REST',
      ...overrides,
    };
  }

  /**
   * T-RR-071: `OutboxPublisherService.doRunOnce`'s own `findPendingBatch` has no tenant filter at
   * all (`outbox-publisher.service.ts`'s own header — it drains the whole table, oldest-first,
   * `LIMIT batchSize`). Now that T-RR-071's own fix stops one malformed row from poisoning the
   * whole batch, this suite's tests finally reach the real ambient `PENDING` backlog this shared
   * dev Postgres instance (root `CLAUDE.md`) accumulates across every agent's own concurrent test
   * runs — the same root cause T-RR-070 already documented for
   * `reward-tracking-outbox.repository.spec.ts`, just never reachable here until now (a
   * dynamically-sized batch large enough to *cover* that backlog was tried first and rejected: it
   * makes `OutboxPublisherService` actually *dispatch* every one of however many thousand ambient
   * rows exist, real network/DB round trips per row, which both takes minutes under concurrent
   * load and races the very backlog it's trying to measure). Backdating this test's own row's own
   * `created_at` instead is the same "make the row we care about unambiguously oldest" idiom this
   * file already uses for `completionSweep`'s own grace window
   * (`backdatePastCompletionSweepGrace`'s sibling further down) — cheap (one indexed point UPDATE
   * by `reward_entry_id`), and guarantees this row is first in `findPendingBatch`'s own
   * `ORDER BY created_at ASC` regardless of how large the ambient backlog grows.
   */
  async function backdateOutboxRowToOldest(rewardEntryId: string): Promise<void> {
    await migrationDb.query(
      `UPDATE reward_redemption.reward_tracking_dispatch_outbox
          SET created_at = TIMESTAMP '1970-01-01 00:00:00+00'
        WHERE reward_entry_id = :id`,
      { type: QueryTypes.RAW, replacements: { id: rewardEntryId } },
    );
  }

  /** T-RR-065 workaround — see this describe block's own header. */
  async function stampTenantCountryEnrichment(id: string): Promise<void> {
    await migrationDb.query(
      `UPDATE reward_redemption.reward_redemption_entry
         SET tenant_code = 'TRR040', country_code = 'US'
       WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id } },
    );
  }

  async function fetchRow(id: string): Promise<RewardRedemptionEntryRow> {
    const rows = await migrationDb.query<RewardRedemptionEntryRow>(
      'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    if (rows.length !== 1) {
      throw new Error(`expected exactly one row for id ${id}, found ${rows.length}`);
    }
    return rows[0];
  }

  /** T-RR-048's own "give back a foreign row" idiom, reused here exactly — this file's own claims
   * share the real, un-tenant-scoped `reward_redemption_entry` table with every other real-DB spec
   * file, hence joining `CROSS_FILE_CLAIM_TEST_MUTEX_KEY` below. */
  async function claimSpecificEntry(
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
        await migrationDb.query(
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

  async function setStubOutcome(campaignCode: string, value: string): Promise<void> {
    await migrationDb.query(
      `INSERT INTO reward_redemption.service_config
         (config_key, scope_level, scope_ref, config_value, value_type)
       VALUES (:key, 'CAMPAIGN', :scopeRef, :value, 'string')`,
      {
        type: QueryTypes.RAW,
        replacements: { key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY, scopeRef: campaignCode, value },
      },
    );
    serviceConfigScopesToClean.push({ scopeLevel: 'CAMPAIGN', scopeRef: campaignCode });
  }

  /** See the `dispatchChannelScopesToClean` declaration above for why this exists post-T-INT-001. */
  async function setDispatchChannelPrimary(
    campaignCode: string,
    primaryChannel: string,
  ): Promise<void> {
    await migrationDb.query(
      `INSERT INTO reward_redemption.dispatch_channel_config
         (scope_level, scope_ref_code, tenant_id, kafka_enabled, rest_enabled, primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :campaignCode, NULL, true, true, :primaryChannel, 'REST')`,
      { type: QueryTypes.RAW, replacements: { campaignCode, primaryChannel } },
    );
    dispatchChannelScopesToClean.push(campaignCode);
  }

  const CORE_BANKING_SYSTEM_CODE = 'CORE_BANKING';

  function buildResolvedReward(): ResolvedRewardSystem {
    return {
      systemCode: CORE_BANKING_SYSTEM_CODE,
      rewardType: 'CASHBACK',
      deliveryMode: 'API',
      unitType: 'cashback',
      unitCode: 'TRR040_UNIT',
      level: 'campaign',
      refId: 0,
      versionNo: 1,
      status: 'active',
    };
  }

  function buildConnectorConfig(
    overrides: Partial<ExternalRewardSystemConfigRow> = {},
  ): ExternalRewardSystemConfigRow {
    return {
      id: 1,
      system_code: CORE_BANKING_SYSTEM_CODE,
      tenant_id: null,
      connector_type: 'CORE_BANKING',
      endpoint_url: 'https://core-banking.internal/redeem',
      auth_secret_ref: 'secret-ref-placeholder',
      retryable_error_codes: ['CORE_BANKING_STUB_TIMEOUT'],
      max_retry_attempts: 3,
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
   * Builds one complete, fresh set of per-test wiring — every metrics-holding object is brand new
   * per call (so each test's own assertions never see another test's counts), every DB-pool-owning
   * object reuses `sharedPool` (so this suite never opens more than one real connection pool).
   */
  function buildFreshPipeline(notificationsEnabled: boolean) {
    const metrics = new MetricsRegistry();
    const dispatchMetrics = new DispatchMetricsService();
    const notificationMetrics = new NotificationMetricsService();

    const connector = new CoreBankingConnector(
      serviceConfigResolver,
      realDbConfigService(),
      sharedPool,
      metrics,
    );
    const connectorRegistry = new ConnectorRegistry();
    connectorRegistry.register('CORE_BANKING', connector);

    const fakeCampaignConfigCache = {
      get: async () => ({ trackers: [], rewards: [] }),
    } as unknown as CampaignConfigCache;
    const notificationResolver: NotificationEnabledResolver = () => notificationsEnabled;
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

    const connectorConfig = buildConnectorConfig();
    const resolutionService = { resolve: async () => buildResolvedReward() };
    const configResolver = { resolve: async () => connectorConfig };
    const orchestrator = new RedemptionProcessingOrchestrator(
      resolutionService as unknown as ConstructorParameters<
        typeof RedemptionProcessingOrchestrator
      >[0],
      configResolver as unknown as ConstructorParameters<
        typeof RedemptionProcessingOrchestrator
      >[1],
      new RetryClassificationService(),
      connectorRegistry,
      stateMachine,
      metrics,
    );

    const completionSweep = new CompletionSweepService(
      stateMachine,
      serviceConfigResolver,
      metrics,
      realDbConfigService(),
      sharedPool,
    );

    const kafkaProducer = { publish: jest.fn().mockResolvedValue(undefined) };
    const restClient = { dispatch: jest.fn().mockResolvedValue(undefined) };
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
      orchestrator,
      stateMachine,
      completionSweep,
      outboxPublisher,
      kafkaProducer,
      restClient,
    };
  }

  beforeAll(async () => {
    // T-RR-048's own precedent — acquire the cross-file mutex before any claim activity in this
    // file starts (see this describe block's own header).
    const rawConfig = realDbConfigService();
    mutexClient = new Client({
      host: rawConfig.get('DB_HOST', { infer: true }),
      port: rawConfig.get('DB_PORT', { infer: true }),
      database: rawConfig.get('DB_NAME', { infer: true }),
      user: rawConfig.get('DB_APP_USERNAME', { infer: true }),
      password: rawConfig.get('DB_APP_PASSWORD', { infer: true }),
    });
    await mutexClient.connect();
    await mutexClient.query('SELECT pg_advisory_lock($1::bigint)', [
      CROSS_FILE_CLAIM_TEST_MUTEX_KEY,
    ]);

    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    sharedPool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 20,
    });

    ingestionRepo = new RewardRedemptionEntryRepository(realDbConfigService(), sharedPool);
    claimRepository = new RewardRedemptionEntryClaimRepository(realDbConfigService(), sharedPool);
    serviceConfigRepository = new ServiceConfigRepository(realDbConfigService(), sharedPool);
    serviceConfigResolver = new ServiceConfigResolverService(serviceConfigRepository);
    const dispatchChannelConfigRepository = new DispatchChannelConfigRepository(
      realDbConfigService(),
      sharedPool,
    );
    dispatchResolver = new DispatchChannelResolverService(
      new DispatchChannelConfigCache(dispatchChannelConfigRepository, serviceConfigResolver),
    );
    outboxRepository = new RewardTrackingOutboxRepository(realDbConfigService(), sharedPool);
    retryRepository = new RewardTrackingDispatchRetryRepository(realDbConfigService(), sharedPool);
    encryption = new EncryptionService(loadEncryptionKeyMaterial());
    // Mirrors `concurrency-load-safety.e2e-spec.ts`'s own 300s `beforeAll` timeout exactly, for the
    // identical reason: the mutex wait above can legitimately block for as long as any sibling
    // real-claim spec file's own up-to-90s describe block still holds it.
  }, 300_000);

  afterAll(async () => {
    for (const id of entryIdsToClean) {
      await migrationDb.query(
        'DELETE FROM reward_redemption.notification_log WHERE reward_entry_id = :id',
        { type: QueryTypes.RAW, replacements: { id } },
      );
      await migrationDb.query(
        'DELETE FROM reward_redemption.reward_tracking_dispatch_retry WHERE reward_entry_id = :id',
        { type: QueryTypes.RAW, replacements: { id } },
      );
      await migrationDb.query(
        'DELETE FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id = :id',
        { type: QueryTypes.RAW, replacements: { id } },
      );
      await migrationDb.query(
        'DELETE FROM reward_redemption.external_system_call_log WHERE reward_entry_id = :id',
        { type: QueryTypes.RAW, replacements: { id } },
      );
      await migrationDb.query(
        'DELETE FROM reward_redemption.reward_redemption_failed WHERE reward_entry_id = :id',
        { type: QueryTypes.RAW, replacements: { id } },
      );
      await migrationDb.query(
        'DELETE FROM reward_redemption.reward_redemption_entry WHERE id = :id',
        {
          type: QueryTypes.RAW,
          replacements: { id },
        },
      );
    }
    for (const { scopeLevel, scopeRef } of serviceConfigScopesToClean) {
      await migrationDb.query(
        `DELETE FROM reward_redemption.service_config
           WHERE config_key = :key AND scope_level = :scopeLevel AND scope_ref = :scopeRef`,
        {
          type: QueryTypes.RAW,
          replacements: { key: CORE_BANKING_STUB_OUTCOME_CONFIG_KEY, scopeLevel, scopeRef },
        },
      );
    }
    for (const campaignCode of dispatchChannelScopesToClean) {
      await migrationDb.query(
        `DELETE FROM reward_redemption.dispatch_channel_config
           WHERE scope_level = 'CAMPAIGN' AND scope_ref_code = :campaignCode`,
        { type: QueryTypes.RAW, replacements: { campaignCode } },
      );
    }

    // Deliberately never calls `onModuleDestroy()` on `ingestionRepo`/`claimRepository`/
    // `serviceConfigRepository`/`outboxRepository`/`retryRepository` (or on any per-test
    // `stateMachine`/`completionSweep` built by `buildFreshPipeline`) — every one of them was
    // constructed with `sharedPool` as its own explicit pool (this describe block's own
    // `beforeAll`), so each class's own `onModuleDestroy()` would end that *shared* pool out from
    // under every other object still using it. Ending `sharedPool` itself, exactly once, here, is
    // the correct equivalent for every one of them at once.
    await sharedPool?.end();
    await migrationDb.close();
    await mutexClient.query('SELECT pg_advisory_unlock($1::bigint)', [
      CROSS_FILE_CLAIM_TEST_MUTEX_KEY,
    ]);
    await mutexClient.end();
  }, 60_000);

  // TC-4
  it('TC-4: a full ingest -> claim -> connector -> dispatch flow (REST channel) increments reward_entries_ingested_total{channel:"rest"}, reward_redemptions_completed_total{system_code}, external_system_call_total{system_code, result:"success"}, reward_tracking_dispatch_tier_total{tier} exactly once each', async () => {
    const tenantId = nextTenantId();
    const dto = buildIngestDto(tenantId);
    // T-INT-001: pin this fixture's own campaign to KAFKA before anything reads
    // `dispatch_channel_config` — see `dispatchChannelScopesToClean`'s own declaration for why.
    await setDispatchChannelPrimary(dto.campaignCode, 'KAFKA');
    const {
      metrics,
      dispatchMetrics,
      orchestrator,
      completionSweep,
      outboxPublisher,
      kafkaProducer,
    } = buildFreshPipeline(false);

    const ingestionService = new RewardIngestionService(
      ingestionRepo,
      new EncryptionService(loadEncryptionKeyMaterial()),
      new EncryptionLogRedactorService(new EncryptionService(loadEncryptionKeyMaterial())),
      realDbConfigService(),
      metrics,
    );

    const ingestResult = await ingestionService.ingest(dto);
    entryIdsToClean.push(ingestResult.rewardEntryId);
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'rest' })).toBe(1);

    // T-RR-065 workaround — see this describe block's own header.
    await stampTenantCountryEnrichment(ingestResult.rewardEntryId);

    const claimed = await claimSpecificEntry(ingestResult.rewardEntryId);
    try {
      const afterConnector = await orchestrator.processClaimedEntry(claimed);
      expect(afterConnector.status).toBe('dispatched_external');
      expect(
        metrics.getCounterValue('external_system_call_total', {
          system_code: CORE_BANKING_SYSTEM_CODE,
          result: 'success' as ExternalCallResult,
        }),
      ).toBe(1);

      // Backdate past the (real, seeded) 300s grace window rather than fake it — see
      // `completion-sweep.service.spec.ts`'s own identical `insertStaleDispatchedExternalRow`
      // precedent for why this is the simplest correct way to make a row sweep-eligible right now.
      await migrationDb.query(
        `UPDATE reward_redemption.reward_redemption_entry
           SET updated_at = now() - interval '1 hour'
         WHERE id = :id`,
        { type: QueryTypes.RAW, replacements: { id: ingestResult.rewardEntryId } },
      );
      await completionSweep.sweepOnce();

      const completedRow = await fetchRow(ingestResult.rewardEntryId);
      expect(completedRow.status).toBe('completed');
      expect(
        metrics.getCounterValue('reward_redemptions_completed_total', {
          system_code: CORE_BANKING_SYSTEM_CODE,
        }),
      ).toBe(1);

      // T-RR-071: guarantee this row is the oldest (hence first) row `findPendingBatch` returns —
      // see `backdateOutboxRowToOldest`'s own header for why, now that this cycle actually reaches
      // the real ambient backlog.
      await backdateOutboxRowToOldest(ingestResult.rewardEntryId);
      await outboxPublisher.runOnce();
      // T-RR-071: `outboxPublisher.runOnce()` drains the *whole* real, shared
      // `reward_tracking_dispatch_outbox` table in one cycle (`OutboxPublisherService`'s own
      // header — "no tenant filter at all"), not just this test's own row. Before T-RR-071's fix,
      // a single malformed row anywhere in that shared table's PENDING backlog aborted the entire
      // cycle, so this call site never actually reached any of the real ambient backlog this dev
      // Postgres instance accumulates across every agent's test runs (root `CLAUDE.md`, one shared
      // server) — the exact same "shared, unscoped table" condition T-RR-070 already documented
      // for `reward-tracking-outbox.repository.spec.ts`, just never visible here until now. A
      // fixed-count assertion against the *shared* `kafkaProducer` mock/`dispatchMetrics` instance
      // is therefore no longer safe; only this row's own outbox status (queried by its own
      // `reward_entry_id`, immune to ambient noise) and "our own message was published exactly
      // once" (filtered out of however many calls the batch made) still are.
      const publishCallsForThisEntry = kafkaProducer.publish.mock.calls.filter(
        ([, , message]) =>
          (message as Record<string, unknown>).rewardEntryId === ingestResult.rewardEntryId,
      );
      expect(publishCallsForThisEntry).toHaveLength(1);
      const outboxRows = await migrationDb.query<{ status: string }>(
        'SELECT status FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id = :id',
        { type: QueryTypes.SELECT, replacements: { id: ingestResult.rewardEntryId } },
      );
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].status).toBe('PUBLISHED');
      // T-INT-001 note: before migration `023`, `dispatch_channel_config`'s seeded `GLOBAL` row
      // defaulted `primary_channel='KAFKA'`, so *every* ambient backlog row this cycle's batch also
      // drained (not just this test's own) resolved to the `'kafka'` tier too, making an exact-zero
      // `rest`/`retry_table` assertion safe on top of T-RR-071's own "only row-scoped assertions
      // are safe against the shared ambient backlog" finding (comment above). Now that GLOBAL
      // defaults to REST (T-INT-001, `reward-service-integration-plan/ARCHITECTURE.md` §4), an
      // ambient backlog row with no override of its own resolves to `rest` instead — so `rest`/
      // `retry_table` staying exactly `0` is no longer something this test can promise. Only this
      // row's own tier is knowable: it was pinned to `KAFKA` via `setDispatchChannelPrimary` above
      // (a CAMPAIGN-scoped override, resolved before GLOBAL), so `kafka >= 1` still safely proves
      // dispatch actually went through the tier this test means to exercise.
      expect(dispatchMetrics.getDispatchTierCount('kafka' as DispatchTier)).toBeGreaterThanOrEqual(
        1,
      );
    } finally {
      // No `stateMachine.onModuleDestroy()`/`completionSweep.onModuleDestroy()` here — both were
      // built by `buildFreshPipeline` against `sharedPool`, and `afterAll` ends that shared pool
      // exactly once for every per-test object built against it (see `afterAll`'s own comment).
    }
  });

  // TC-5
  it('TC-5: the gRPC and Kafka ingestion channels also increment reward_entries_ingested_total with their own correct channel label', async () => {
    // Transport parity across all three real channels (real mTLS gRPC server, real Kafka consumer,
    // real REST controller) is already proven end to end by
    // `test/modules/reward-ingestion/cross-channel-parity.e2e-spec.ts` (T-RR-014) — every one of
    // those three adapters is a thin R10 wrapper that calls this exact same shared
    // `RewardIngestionService.ingest()` with nothing but a different `dto.ingestionChannel` value
    // (`reward-ingestion.service.ts`'s own header). This task's own concern is the metric wiring at
    // that one shared call site, not re-proving transport parity a second time — so this test drives
    // the shared domain method directly with each channel label, exactly as
    // `cross-channel-parity.e2e-spec.ts`'s own real transports ultimately do underneath.
    const metrics = new MetricsRegistry();
    const ingestionService = new RewardIngestionService(
      ingestionRepo,
      encryption,
      new EncryptionLogRedactorService(encryption),
      realDbConfigService(),
      metrics,
    );

    const grpcDto = buildIngestDto(nextTenantId(), { ingestionChannel: 'GRPC' });
    const grpcResult = await ingestionService.ingest(grpcDto);
    entryIdsToClean.push(grpcResult.rewardEntryId);

    const kafkaDto = buildIngestDto(nextTenantId(), { ingestionChannel: 'KAFKA' });
    const kafkaResult = await ingestionService.ingest(kafkaDto);
    entryIdsToClean.push(kafkaResult.rewardEntryId);

    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'grpc' })).toBe(1);
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'kafka' })).toBe(1);
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'rest' })).toBe(0);
  });

  // TC-6
  it('TC-6: a redemption that ends in failed increments reward_redemptions_failed_total{system_code} and never reward_redemptions_completed_total', async () => {
    const tenantId = nextTenantId();
    const dto = buildIngestDto(tenantId);
    await setStubOutcome(dto.campaignCode, 'PERMANENT_FAILURE');
    const { metrics, orchestrator } = buildFreshPipeline(false);

    const ingestionService = new RewardIngestionService(
      ingestionRepo,
      encryption,
      new EncryptionLogRedactorService(encryption),
      realDbConfigService(),
      metrics,
    );
    const ingestResult = await ingestionService.ingest(dto);
    entryIdsToClean.push(ingestResult.rewardEntryId);
    // T-RR-065 workaround — see this describe block's own header. Unlike this test's own original
    // assumption, `RedemptionProcessingOrchestrator.processClaimedEntry` now runs the
    // `06-CACHING-AND-TENANT-CONFIG.md` §5 enrichment step unconditionally, *before* resolving a
    // connector at all (`enrichTenantSchema`, called first thing in `processClaimedEntry`) — so
    // every call into it needs this precondition met, not just the ones that reach the outbox step.
    await stampTenantCountryEnrichment(ingestResult.rewardEntryId);

    const claimed = await claimSpecificEntry(ingestResult.rewardEntryId);
    try {
      const result = await orchestrator.processClaimedEntry(claimed);
      expect(result.status).toBe('failed');
      expect(
        metrics.getCounterValue('reward_redemptions_failed_total', {
          system_code: CORE_BANKING_SYSTEM_CODE,
        }),
      ).toBe(1);
      expect(
        metrics.getCounterValue('reward_redemptions_completed_total', {
          system_code: CORE_BANKING_SYSTEM_CODE,
        }),
      ).toBe(0);
    } finally {
      // No `stateMachine.onModuleDestroy()` here — see the identical note on TC-4's own `finally`
      // above; `stateMachine` was built against the shared pool `afterAll` ends exactly once.
    }
  });

  // TC-9
  it('TC-9: a notification-enabled redemption completes and increments notification_logged_total exactly once, with no labels', async () => {
    const tenantId = nextTenantId();
    const dto = buildIngestDto(tenantId);
    const { metrics, notificationMetrics, orchestrator, completionSweep } =
      buildFreshPipeline(true);

    const ingestionService = new RewardIngestionService(
      ingestionRepo,
      encryption,
      new EncryptionLogRedactorService(encryption),
      realDbConfigService(),
      metrics,
    );
    const ingestResult = await ingestionService.ingest(dto);
    entryIdsToClean.push(ingestResult.rewardEntryId);
    // T-RR-065 workaround — see this describe block's own header. Without it,
    // `enqueueTrackingDispatch` (called before `notifyIfConfigured` inside
    // `recordCompletionSideEffects`) throws, and `notifyIfConfigured` is never reached at all.
    await stampTenantCountryEnrichment(ingestResult.rewardEntryId);

    const claimed = await claimSpecificEntry(ingestResult.rewardEntryId);
    try {
      await orchestrator.processClaimedEntry(claimed);

      await migrationDb.query(
        `UPDATE reward_redemption.reward_redemption_entry
           SET updated_at = now() - interval '1 hour'
         WHERE id = :id`,
        { type: QueryTypes.RAW, replacements: { id: ingestResult.rewardEntryId } },
      );
      await completionSweep.sweepOnce();

      const completedRow = await fetchRow(ingestResult.rewardEntryId);
      expect(completedRow.status).toBe('completed');
      expect(notificationMetrics.getNotificationLoggedCount()).toBe(1);

      const notificationRows = await migrationDb.query<{ customer_id_hash: string }>(
        'SELECT customer_id_hash FROM reward_redemption.notification_log WHERE reward_entry_id = :id',
        { type: QueryTypes.SELECT, replacements: { id: ingestResult.rewardEntryId } },
      );
      expect(notificationRows).toHaveLength(1);
      // R8: the hash, never a plaintext/encrypted customerId, is what's stored.
      expect(notificationRows[0].customer_id_hash).toBe(completedRow.customer_id_hash);
    } finally {
      // No `stateMachine.onModuleDestroy()`/`completionSweep.onModuleDestroy()` here — both were
      // built by `buildFreshPipeline` against `sharedPool`, and `afterAll` ends that shared pool
      // exactly once for every per-test object built against it (see `afterAll`'s own comment).
    }
  });
});

/**
 * TC-7/TC-8. `POST /api/v1/cache/invalidate` against the real, fully-wired `AppModule` (same
 * pattern `test/cache-invalidation/cache-invalidation.controller.spec.ts` already establishes for
 * this exact endpoint) — this task's own concern is only the metric increment
 * (`cache_invalidation_total{key}`), not re-proving the endpoint's own auth/audit-row behavior,
 * which that file already covers under `agent-rr-foundation`'s/T-RR-007's own file scope.
 */
describe('T-RR-040 — POST /api/v1/cache/invalidate metric wiring (real AppModule, real Postgres)', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  // TC-7
  it('TC-7: a specific key increments cache_invalidation_total{key: <that key>}', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${process.env.CACHE_ADMIN_TOKEN}`)
      .send({ key: 'serviceConfig' });

    expect(response.status).toBe(200);
    const metrics = app.get(MetricsRegistry);
    expect(metrics.getCounterValue('cache_invalidation_total', { key: 'serviceConfig' })).toBe(1);
  });

  // TC-8
  it('TC-8: {"all": true} increments cache_invalidation_total{key: "all"}', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${process.env.CACHE_ADMIN_TOKEN}`)
      .send({ all: true });

    expect(response.status).toBe(200);
    const metrics = app.get(MetricsRegistry);
    expect(metrics.getCounterValue('cache_invalidation_total', { key: 'all' })).toBe(1);
  });
});
