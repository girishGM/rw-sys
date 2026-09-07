/**
 * T-RR-024 — `RedemptionProcessingOrchestrator`. Every collaborator is a plain test double (same
 * "construct directly, no `TestingModule`" idiom `reward-system-resolution.service.spec.ts` and
 * `retry-classification.service.spec.ts` already established) except TC-7, which exercises the real
 * claim SQL against the real local Postgres — this orchestrator never sees a row before its own
 * `next_attempt_at` has elapsed, so TC-7 proves that property at the layer that actually enforces it
 * (the claim query, T-RR-020), not by asserting anything about this orchestrator's own behavior
 * (this task's own test-case table, TC-7's own note).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import type { RedemptionResult } from '@/modules/connectors/reward-system-connector.interface';
import { UnknownConnectorTypeError } from '@/modules/connectors/connector-registry';
import { RedemptionProcessingOrchestrator } from '@/modules/processing/redemption-processing-orchestrator.service';
import { RewardRedemptionEntryClaimRepository } from '@/modules/processing/reward-redemption-entry-claim.repository';
import type { ResolvedRewardSystem } from '@/modules/processing/reward-system-resolution.service';
import { RetryClassificationService } from '@/modules/reward-system-config/retry-classification.service';
import { MetricsRegistry } from '@/observability/metrics.registry';
import type { Config } from '@/config/config.schema';

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
    activity_name: 't-rr-024 orchestrator fixture',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'PROMO_CODE_SERVICE',
    reward_category: 'VOUCHER',
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

function buildResolvedReward(overrides: Partial<ResolvedRewardSystem> = {}): ResolvedRewardSystem {
  return {
    systemCode: 'PROMO_CODE_SERVICE',
    rewardType: 'VOUCHER',
    deliveryMode: 'API',
    unitType: 'voucher',
    unitCode: 'VOUCHER_10',
    level: 'campaign',
    refId: 0,
    versionNo: 1,
    status: 'active',
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
    endpoint_url: 'https://promo-code-service.internal/api/v1/promo-codes/generate',
    auth_secret_ref: 'secret-ref-placeholder',
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

interface Harness {
  orchestrator: RedemptionProcessingOrchestrator;
  resolutionService: { resolve: jest.Mock };
  configResolver: { resolve: jest.Mock };
  connectorRegistry: { resolve: jest.Mock };
  stateMachine: {
    markDispatchedExternal: jest.Mock;
    markCompletedDirect: jest.Mock;
    markRetrying: jest.Mock;
    markFailed: jest.Mock;
  };
  connector: { redeem: jest.Mock };
  metrics: MetricsRegistry;
  tenantSchemaEnrichment: { enrich: jest.Mock };
}

/** T-RR-065: every test in this file drives entries through claim-time enrichment first — this
 * default mock reproduces the real `TenantSchemaEnrichmentService.enrich()` contract (stamp
 * `tenant_code`/`country_code` if missing, pass through unchanged otherwise) without touching a
 * real cache/DB, so every pre-existing test below keeps exercising §4-§7 exactly as before. Tests
 * that care about enrichment itself override this mock explicitly (see the "T-RR-065" describe
 * block). */
function buildEnrichedEntry(entry: RewardRedemptionEntryRow): RewardRedemptionEntryRow {
  if (entry.tenant_code !== null && entry.country_code !== null) {
    return entry;
  }
  return { ...entry, tenant_code: 'TENANT1', country_code: 'US' };
}

interface HarnessOverrides {
  /** `undefined` (the default) builds the usual passthrough-enrichment mock. Explicit `null` means
   * "construct the orchestrator with no seventh argument at all" — `??` alone can't distinguish
   * "key omitted" from "key present but `undefined`", so TC-1 below (the one test that needs a real
   * absent dependency, not just an absent override) passes `null` deliberately. */
  tenantSchemaEnrichment?: { enrich: jest.Mock } | null;
}

function buildHarness(overrides: HarnessOverrides = {}): Harness {
  const resolutionService = { resolve: jest.fn().mockResolvedValue(buildResolvedReward()) };
  const configResolver = { resolve: jest.fn().mockResolvedValue(buildConnectorConfig()) };
  const connector: { redeem: jest.Mock } = { redeem: jest.fn() };
  const connectorRegistry = { resolve: jest.fn().mockReturnValue(connector) };
  const stateMachine = {
    markDispatchedExternal: jest
      .fn()
      .mockImplementation(async (input) =>
        buildEntry({ id: input.entryId, status: 'dispatched_external' }),
      ),
    markCompletedDirect: jest
      .fn()
      .mockImplementation(async (entryId: string) =>
        buildEntry({ id: entryId, status: 'completed' }),
      ),
    markRetrying: jest
      .fn()
      .mockImplementation(async (input) => buildEntry({ id: input.entryId, status: 'retrying' })),
    markFailed: jest
      .fn()
      .mockImplementation(async (input) => buildEntry({ id: input.entryId, status: 'failed' })),
  };
  const retryClassification = new RetryClassificationService();
  const metrics = new MetricsRegistry();
  const tenantSchemaEnrichmentOmitted = overrides.tenantSchemaEnrichment === null;
  const tenantSchemaEnrichment = tenantSchemaEnrichmentOmitted
    ? undefined
    : (overrides.tenantSchemaEnrichment ?? {
        enrich: jest
          .fn()
          .mockImplementation(async (entry: RewardRedemptionEntryRow) => buildEnrichedEntry(entry)),
      });

  const orchestrator = tenantSchemaEnrichmentOmitted
    ? new RedemptionProcessingOrchestrator(
        resolutionService as unknown as ConstructorParameters<
          typeof RedemptionProcessingOrchestrator
        >[0],
        configResolver as unknown as ConstructorParameters<
          typeof RedemptionProcessingOrchestrator
        >[1],
        retryClassification,
        connectorRegistry as unknown as ConstructorParameters<
          typeof RedemptionProcessingOrchestrator
        >[3],
        stateMachine as unknown as ConstructorParameters<
          typeof RedemptionProcessingOrchestrator
        >[4],
        metrics,
      )
    : new RedemptionProcessingOrchestrator(
        resolutionService as unknown as ConstructorParameters<
          typeof RedemptionProcessingOrchestrator
        >[0],
        configResolver as unknown as ConstructorParameters<
          typeof RedemptionProcessingOrchestrator
        >[1],
        retryClassification,
        connectorRegistry as unknown as ConstructorParameters<
          typeof RedemptionProcessingOrchestrator
        >[3],
        stateMachine as unknown as ConstructorParameters<
          typeof RedemptionProcessingOrchestrator
        >[4],
        metrics,
        tenantSchemaEnrichment as unknown as ConstructorParameters<
          typeof RedemptionProcessingOrchestrator
        >[6],
      );

  return {
    orchestrator,
    resolutionService,
    configResolver,
    connectorRegistry,
    stateMachine,
    connector,
    metrics,
    tenantSchemaEnrichment: (tenantSchemaEnrichment ?? { enrich: jest.fn() }) as {
      enrich: jest.Mock;
    },
  };
}

describe('T-RR-024 — RedemptionProcessingOrchestrator', () => {
  it('TC-1: connector call succeeds -> calls markDispatchedExternal, never markCompletedDirect', async () => {
    const { orchestrator, stateMachine, connector, metrics } = buildHarness();
    const entry = buildEntry({ retry_count: 0 });
    const success: RedemptionResult = {
      outcome: 'SUCCESS',
      externalReferenceId: 'PROMO-ABC123',
      responseSummary: { status: 'SUCCESS' },
    };
    connector.redeem.mockResolvedValue(success);

    const result = await orchestrator.processClaimedEntry(entry);

    // T-RR-067: `markDispatchedExternal` no longer takes `attemptNumber`/`requestSummary`/
    // `responseSummary`/`latencyMs` — it no longer writes `external_system_call_log` itself (the
    // connector that just returned `success` above already wrote its own row for this attempt).
    expect(stateMachine.markDispatchedExternal).toHaveBeenCalledWith({
      entryId: entry.id,
      externalSystemCode: 'PROMO_CODE_SERVICE',
      externalReferenceId: 'PROMO-ABC123',
    });
    expect(stateMachine.markCompletedDirect).not.toHaveBeenCalled();
    expect(stateMachine.markRetrying).not.toHaveBeenCalled();
    expect(stateMachine.markFailed).not.toHaveBeenCalled();
    expect(result.status).toBe('dispatched_external');

    // T-RR-057: `dispatched_external` is not `completed` yet — neither counter moves on this
    // branch (the eventual `completed` increment belongs to `CompletionSweepService`, T-RR-021).
    expect(metrics.getCounterValue('reward_redemptions_completed_total')).toBe(0);
    expect(metrics.getCounterValue('reward_redemptions_failed_total')).toBe(0);
  });

  it('TC-2: no active connector config resolves -> markCompletedDirect directly, connector never called', async () => {
    const { orchestrator, configResolver, connectorRegistry, stateMachine, connector, metrics } =
      buildHarness();
    configResolver.resolve.mockResolvedValue(null);
    const entry = buildEntry();

    const result = await orchestrator.processClaimedEntry(entry);

    expect(stateMachine.markCompletedDirect).toHaveBeenCalledWith(entry.id);
    expect(connectorRegistry.resolve).not.toHaveBeenCalled();
    expect(connector.redeem).not.toHaveBeenCalled();
    expect(stateMachine.markDispatchedExternal).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');

    // T-RR-057 regression: this is the direct no-external-call `-> completed` path
    // `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3 explicitly calls out — before the fix, this
    // counter never moved for any call site, this one included.
    expect(
      metrics.getCounterValue('reward_redemptions_completed_total', {
        system_code: 'PROMO_CODE_SERVICE',
      }),
    ).toBe(1);
    expect(metrics.getCounterValue('reward_redemptions_failed_total')).toBe(0);
  });

  it('TC-3: retryable failure, retry_count below max -> markRetrying with incremented attempt + computed backoff', async () => {
    const { orchestrator, configResolver, stateMachine, connector, metrics } = buildHarness();
    configResolver.resolve.mockResolvedValue(
      buildConnectorConfig({
        max_retry_attempts: 5,
        retry_backoff_base_ms: 500,
        retry_backoff_max_ms: 30_000,
      }),
    );
    // retry_count = 2 means 2 prior failures already happened; this 3rd attempt fails too.
    const entry = buildEntry({ retry_count: 2 });
    const retryable: RedemptionResult = {
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'GENERATION_EXHAUSTED',
      errorMessage: 'retry budget exhausted, try again later',
    };
    connector.redeem.mockResolvedValue(retryable);

    const result = await orchestrator.processClaimedEntry(entry);

    // delayMs = min(500 * 2^(3-1), 30000) = 2000.
    expect(stateMachine.markRetrying).toHaveBeenCalledWith({
      entryId: entry.id,
      errorCode: 'GENERATION_EXHAUSTED',
      errorMessage: 'retry budget exhausted, try again later',
      delayMs: 2000,
    });
    expect(stateMachine.markFailed).not.toHaveBeenCalled();
    expect(result.status).toBe('retrying');

    // T-RR-057: a `retrying` transition is neither `completed` nor `failed` — no counter moves.
    expect(metrics.getCounterValue('reward_redemptions_completed_total')).toBe(0);
    expect(metrics.getCounterValue('reward_redemptions_failed_total')).toBe(0);
  });

  it('TC-4: retryable failure, retry_count already at max -> markFailed (exhaustion), never another markRetrying', async () => {
    const { orchestrator, configResolver, stateMachine, connector, metrics } = buildHarness();
    configResolver.resolve.mockResolvedValue(buildConnectorConfig({ max_retry_attempts: 5 }));
    // retry_count = 4 -> this attempt is the 5th; max_retry_attempts = 5 -> exhausted.
    const entry = buildEntry({ retry_count: 4 });
    const retryable: RedemptionResult = {
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'GENERATION_EXHAUSTED',
      errorMessage: 'still exhausted',
    };
    connector.redeem.mockResolvedValue(retryable);

    const result = await orchestrator.processClaimedEntry(entry);

    expect(stateMachine.markFailed).toHaveBeenCalledWith({
      entryId: entry.id,
      totalAttempts: 5,
      finalErrorCode: 'GENERATION_EXHAUSTED',
      finalErrorMessage: 'still exhausted',
    });
    expect(stateMachine.markRetrying).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');

    // T-RR-057 regression: retry exhaustion is a `failed` transition — before the fix, this
    // counter never moved for any call site, this one included.
    expect(
      metrics.getCounterValue('reward_redemptions_failed_total', {
        system_code: 'PROMO_CODE_SERVICE',
      }),
    ).toBe(1);
    expect(metrics.getCounterValue('reward_redemptions_completed_total')).toBe(0);
  });

  it('TC-5: permanent failure on first attempt -> markFailed immediately, total_attempts = 1', async () => {
    const { orchestrator, stateMachine, connector, metrics } = buildHarness();
    const entry = buildEntry({ retry_count: 0 });
    const permanent: RedemptionResult = {
      outcome: 'PERMANENT_FAILURE',
      errorCode: 'CONFIG_NOT_BOUND',
      errorMessage: 'campaign/tracker/component was never bound to a promo-code config',
    };
    connector.redeem.mockResolvedValue(permanent);

    const result = await orchestrator.processClaimedEntry(entry);

    expect(stateMachine.markFailed).toHaveBeenCalledWith({
      entryId: entry.id,
      totalAttempts: 1,
      finalErrorCode: 'CONFIG_NOT_BOUND',
      finalErrorMessage: 'campaign/tracker/component was never bound to a promo-code config',
    });
    expect(stateMachine.markRetrying).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');

    // T-RR-057 regression: a permanent failure on the very first attempt is still a `failed`
    // transition — before the fix, this counter never moved for any call site, this one included.
    expect(
      metrics.getCounterValue('reward_redemptions_failed_total', {
        system_code: 'PROMO_CODE_SERVICE',
      }),
    ).toBe(1);
    expect(metrics.getCounterValue('reward_redemptions_completed_total')).toBe(0);
  });

  it('TC-6 (negative): never opens/records a transition before the (artificially slow) connector call resolves', async () => {
    const { orchestrator, stateMachine, connector } = buildHarness();
    const entry = buildEntry();
    const events: string[] = [];

    connector.redeem.mockImplementation(
      () =>
        new Promise<RedemptionResult>((resolve) => {
          setTimeout(() => {
            events.push('connector-resolved');
            resolve({
              outcome: 'SUCCESS',
              externalReferenceId: 'PROMO-SLOW',
              responseSummary: {},
            });
          }, 30);
        }),
    );
    for (const fn of Object.values(stateMachine)) {
      fn.mockImplementation(async (...args: unknown[]) => {
        events.push('state-machine-called');
        return buildEntry({ id: (args[0] as { entryId?: string })?.entryId ?? entry.id });
      });
    }

    await orchestrator.processClaimedEntry(entry);

    expect(events).toEqual(['connector-resolved', 'state-machine-called']);
  });

  it('propagates UnknownConnectorTypeError rather than silently swallowing a data/config error', async () => {
    const { orchestrator, connectorRegistry, connector } = buildHarness();
    connectorRegistry.resolve.mockImplementation(() => {
      throw new UnknownConnectorTypeError('NOT_A_REAL_CONNECTOR');
    });

    await expect(orchestrator.processClaimedEntry(buildEntry())).rejects.toBeInstanceOf(
      UnknownConnectorTypeError,
    );
    expect(connector.redeem).not.toHaveBeenCalled();
  });

  it('T-RR-057 TC-3 (regression): a thrown markCompletedDirect never increments reward_redemptions_completed_total', async () => {
    const { orchestrator, configResolver, stateMachine, metrics } = buildHarness();
    configResolver.resolve.mockResolvedValue(null);
    stateMachine.markCompletedDirect.mockRejectedValue(new Error('simulated DB failure'));

    await expect(orchestrator.processClaimedEntry(buildEntry())).rejects.toThrow(
      'simulated DB failure',
    );

    expect(metrics.getCounterValue('reward_redemptions_completed_total')).toBe(0);
  });

  it('T-RR-057 TC-3 (regression): a thrown markFailed never increments reward_redemptions_failed_total', async () => {
    const { orchestrator, stateMachine, connector, metrics } = buildHarness();
    stateMachine.markFailed.mockRejectedValue(new Error('simulated DB failure'));
    connector.redeem.mockResolvedValue({
      outcome: 'PERMANENT_FAILURE',
      errorCode: 'CONFIG_NOT_BOUND',
      errorMessage: 'campaign/tracker/component was never bound to a promo-code config',
    });

    await expect(orchestrator.processClaimedEntry(buildEntry())).rejects.toThrow(
      'simulated DB failure',
    );

    expect(metrics.getCounterValue('reward_redemptions_failed_total')).toBe(0);
  });

  describe('T-RR-065 — claim-time tenant_code/country_code enrichment runs before §4-§7', () => {
    it('TC-1: reproduces the reported defect — an unenriched entry with no TenantSchemaEnrichmentService wired throws before any resolution/connector call, never silently proceeding', async () => {
      const { orchestrator, resolutionService, connector } = buildHarness({
        tenantSchemaEnrichment: null,
      });
      const entry = buildEntry({ tenant_code: null, country_code: null });

      await expect(orchestrator.processClaimedEntry(entry)).rejects.toThrow(
        /no tenant_code\/country_code and no TenantSchemaEnrichmentService/,
      );
      expect(resolutionService.resolve).not.toHaveBeenCalled();
      expect(connector.redeem).not.toHaveBeenCalled();
    });

    it('TC-2: an unenriched entry is enriched before resolutionService.resolve/connector.redeem ever run, and the enriched row (not the raw claimed one) flows through the rest of the pipeline', async () => {
      const { orchestrator, resolutionService, connector, stateMachine, tenantSchemaEnrichment } =
        buildHarness();
      const entry = buildEntry({ tenant_code: null, country_code: null });
      const success: RedemptionResult = {
        outcome: 'SUCCESS',
        externalReferenceId: 'PROMO-T-RR-065',
        responseSummary: {},
      };
      connector.redeem.mockResolvedValue(success);

      const callOrder: string[] = [];
      tenantSchemaEnrichment.enrich.mockImplementation(async (e: RewardRedemptionEntryRow) => {
        callOrder.push('enrich');
        return buildEnrichedEntry(e);
      });
      resolutionService.resolve.mockImplementation(async () => {
        callOrder.push('resolve');
        return buildResolvedReward();
      });
      connector.redeem.mockImplementation(async () => {
        callOrder.push('connector.redeem');
        return success;
      });

      await orchestrator.processClaimedEntry(entry);

      expect(tenantSchemaEnrichment.enrich).toHaveBeenCalledWith(entry);
      expect(callOrder).toEqual(['enrich', 'resolve', 'connector.redeem']);
      // 08-EXTERNAL-INTEGRATION-CONTRACTS.md's own `ClaimedRewardEntry` contract: the connector
      // receives the row with enrichment already stamped onto it, never the raw claimed row.
      const connectorCallEntry = connector.redeem.mock.calls[0][0] as RewardRedemptionEntryRow;
      expect(connectorCallEntry.tenant_code).toBe('TENANT1');
      expect(connectorCallEntry.country_code).toBe('US');
      expect(stateMachine.markDispatchedExternal).toHaveBeenCalledWith(
        expect.objectContaining({ entryId: entry.id }),
      );
    });

    it('TC-3 (regression): an entry that already carries tenant_code/country_code never calls TenantSchemaEnrichmentService at all', async () => {
      const { orchestrator, connector, tenantSchemaEnrichment } = buildHarness();
      const entry = buildEntry({ tenant_code: 'ALREADY', country_code: 'DE' });
      connector.redeem.mockResolvedValue({
        outcome: 'SUCCESS',
        externalReferenceId: 'PROMO-ALREADY-ENRICHED',
        responseSummary: {},
      });

      await orchestrator.processClaimedEntry(entry);

      expect(tenantSchemaEnrichment.enrich).not.toHaveBeenCalled();
      const connectorCallEntry = connector.redeem.mock.calls[0][0] as RewardRedemptionEntryRow;
      expect(connectorCallEntry.tenant_code).toBe('ALREADY');
      expect(connectorCallEntry.country_code).toBe('DE');
    });

    it('TC-4 (adjacent behaviour unchanged): the no-connector direct -> completed path still runs after enrichment, using the enriched entry id', async () => {
      const { orchestrator, configResolver, stateMachine, tenantSchemaEnrichment, metrics } =
        buildHarness();
      configResolver.resolve.mockResolvedValue(null);
      const entry = buildEntry({ tenant_code: null, country_code: null });

      const result = await orchestrator.processClaimedEntry(entry);

      expect(tenantSchemaEnrichment.enrich).toHaveBeenCalledWith(entry);
      expect(stateMachine.markCompletedDirect).toHaveBeenCalledWith(entry.id);
      expect(result.status).toBe('completed');
      expect(
        metrics.getCounterValue('reward_redemptions_completed_total', {
          system_code: 'PROMO_CODE_SERVICE',
        }),
      ).toBe(1);
    });

    it('TC-5 (propagation): a rejected enrich() call propagates, never swallowed, and no resolution/connector/state-machine call happens', async () => {
      const { orchestrator, resolutionService, connector, stateMachine, tenantSchemaEnrichment } =
        buildHarness();
      tenantSchemaEnrichment.enrich.mockRejectedValue(
        new Error('tenant_schema_config resolution matched 0 active row(s)'),
      );

      await expect(
        orchestrator.processClaimedEntry(buildEntry({ tenant_code: null, country_code: null })),
      ).rejects.toThrow('tenant_schema_config resolution matched 0 active row(s)');

      expect(resolutionService.resolve).not.toHaveBeenCalled();
      expect(connector.redeem).not.toHaveBeenCalled();
      expect(stateMachine.markDispatchedExternal).not.toHaveBeenCalled();
      expect(stateMachine.markCompletedDirect).not.toHaveBeenCalled();
    });
  });
});

/**
 * TC-7 — real Postgres. Proves the property this orchestrator's own correctness depends on but
 * never itself enforces: a `retrying` row whose `next_attempt_at` is still in the future is never
 * returned by the claim query (T-RR-020), no matter how many times it runs. Seeded directly via the
 * migration connection and exercised through the real `RewardRedemptionEntryClaimRepository` — this
 * describe block does not construct `RedemptionProcessingOrchestrator` at all, per this task's own
 * test-case note ("rather than asserting anything about this orchestrator's own behavior").
 */
describe('T-RR-024 — TC-7 (real Postgres): a future next_attempt_at is never claimed', () => {
  const TENANT_ID = 924_000 + Math.floor(Math.random() * 1000);
  let migrationDb: Sequelize;
  let repository: RewardRedemptionEntryClaimRepository;

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

  function baseEntryFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: randomUUID(),
      correlation_id: randomUUID(),
      tenant_id: TENANT_ID,
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
      activity_name: 't-rr-024 orchestrator TC-7 fixture',
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
      status: 'received',
      retry_count: 0,
      next_attempt_at: null,
      created_at: new Date(),
      ...overrides,
    };
  }

  async function insertEntry(overrides: Record<string, unknown> = {}): Promise<string> {
    const f = baseEntryFields(overrides);
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
      { type: QueryTypes.SELECT, replacements: f },
    );
    return row.id;
  }

  async function fetchStatus(id: string): Promise<string> {
    const [row] = await migrationDb.query<{ status: string }>(
      'SELECT status FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return row.status;
  }

  /** Tolerant of foreign rows claimed along the way (same shared, un-tenant-scoped table every
   * other real-Postgres claim spec already documents) — gives any non-matching claim back
   * immediately rather than stranding it, mirroring `reward-redemption-entry-claim.repository
   * .spec.ts`'s own `giveBackForeignRow`/`claimUntil` idiom, kept minimal here since this describe
   * block is a single, bounded, one-off check rather than a heavy contention suite. */
  async function giveBackForeignRow(id: string): Promise<void> {
    await migrationDb.query(
      `UPDATE reward_redemption.reward_redemption_entry
         SET status = 'received', updated_at = now(), created_at = now()
       WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id } },
    );
  }

  async function claimUntilProcessing(targetId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const claimed = await repository.claimNext();
      if (claimed && claimed.id !== targetId) {
        await giveBackForeignRow(claimed.id);
      }
      if ((await fetchStatus(targetId)) === 'processing') {
        return;
      }
    }
    throw new Error(
      `claimUntilProcessing: ${targetId} did not reach 'processing' within ${timeoutMs}ms`,
    );
  }

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    repository = new RewardRedemptionEntryClaimRepository(realDbConfigService());
  }, 60_000);

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
    await repository.onModuleDestroy();
  }, 60_000);

  it('TC-7: seeds a retrying row with a future next_attempt_at; the real claim query never returns it', async () => {
    const futureId = await insertEntry({
      status: 'retrying',
      next_attempt_at: new Date(Date.now() + 60_000),
    });
    // A control row backdated well ahead of any real-time-dated foreign row, so it is always this
    // test's own next claim target regardless of other concurrently-running spec files' fixtures
    // (`reward-redemption-entry-claim.repository.spec.ts`'s own `nextOldTimestamp` idiom).
    const controlId = await insertEntry({
      status: 'received',
      created_at: new Date(Date.parse('2000-01-01T00:00:00.000Z')),
    });

    await claimUntilProcessing(controlId);

    expect(await fetchStatus(futureId)).toBe('retrying');
  }, 90_000);
});
