/**
 * T-RR-032. `CoreBankingConnector` — a second, real implementation of `RewardSystemConnector`
 * (`reward-system-connector.interface.ts`, T-RR-030) for `connector_type = 'CORE_BANKING'`
 * (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §3), so that code path is genuinely resolvable and
 * testable end to end even though **no real core-banking cashback API exists anywhere in this
 * repo, and building one is explicitly out of scope** (`ARCHITECTURE.md` §11, `BACKLOG.md` B-2).
 *
 * This class performs **zero I/O** — no socket, no HTTP request, no gRPC call, ever, on any
 * branch. It only:
 *   1. Resolves a configurable canned outcome (`connectors.coreBanking.stubOutcome`) via T-RR-006's
 *      `ServiceConfigResolverService` (implementation note 1) — never a hardcoded compiled-in
 *      constant, so a future task can exercise any of `05-PROCESSING-PIPELINE.md` §5/§6/§7's
 *      branches against this connector without a redeploy (verification step 3).
 *   2. Synthesizes a plausible request/response shape for whichever outcome is configured
 *      (implementation note 2) and logs what a real call *would* have looked like, at the same
 *      structured-logging fidelity a real connector uses (implementation note 3,
 *      `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §2) — same `{ message, rewardEntryId,
 *      correlationId, tenantId, campaignCode, ... }` shape `RewardIngestionService.ingest()`
 *      already establishes.
 *   3. Writes its own `external_system_call_log` row for every resolved outcome (implementation
 *      note 4, `01-DATABASE.md` §9), `latency_ms` reflecting the actual (near-zero) elapsed time —
 *      no artificial `setTimeout` to fake network latency, which would misrepresent this stub as
 *      doing real I/O when it explicitly is not.
 *
 * **`connectors.coreBanking.stubOutcome` has no seeded `GLOBAL` row in any migration — a
 * deliberate design choice, not an oversight (flagged in this task's own completion report per
 * `AGENT-PROTOCOL.md` §3).** Implementation note 1 asks this to be "seeded" as a `GLOBAL` default
 * of `'SUCCESS'`, but `src/database/**` (including every `service_config` seed migration) is
 * `agent-rr-foundation`'s own file-scope grant only (R3) — see
 * `015_seed_service_config_defaults.ts`'s own "Process note for future knobs" for the precedent
 * this connector follows instead: `resolveStubOutcome` below catches exactly
 * `ServiceConfigNotFoundError` (never `ServiceConfigTypeError`, which is a genuine data/config
 * error that must still propagate) and falls back to `DEFAULT_STUB_OUTCOME` with a one-time warn
 * log, the same "unseeded-until-a-future-migration-lands, fall back loudly rather than crash"
 * convention `dispatch.config.ts`'s `resolveKafkaAttemptsBeforeFallback`/`resolveOutboxPollIntervalMs`
 * (T-RR-034/T-RR-035, also `agent-rr-integration`'s own) already establish. This satisfies
 * implementation note 1's actual intent — "not accidentally the reason a full-pipeline e2e test
 * (T-RR-041) fails without an explicit override" — without requiring a migration-owning task's own
 * file grant: an environment with no `connectors.coreBanking.stubOutcome` row at all still resolves
 * to `'SUCCESS'` today, and one that seeds a real row (a future task's prerogative) simply overrides
 * it, per the normal `CAMPAIGN`/`TENANT`/`COUNTRY`/`GLOBAL` precedence.
 *
 * No transaction, no advisory lock threaded through `redeem()` (`05-PROCESSING-PIPELINE.md` §3) —
 * same "own short-lived pool queries only" discipline `PromoCodeServiceConnector` documents.
 *
 * **`external_system_call_log` double-write — reported as T-RR-067, fixed in
 * `redemption-state-machine.service.ts`, not here.** Implementation note 4 requires this connector
 * to write its own `external_system_call_log` row for every resolved outcome, `SUCCESS` included —
 * unchanged by that fix. `RedemptionStateMachineService.markDispatchedExternal` (T-RR-021) used to
 * *also* insert a row on every `SUCCESS` transition; T-RR-067 removed that second write from
 * `markDispatchedExternal` instead, so this connector's own unconditional write (`writeCallLog`
 * below) is the only remaining writer for a call this connector makes. See that method's own
 * `MarkDispatchedExternalInput` doc comment and `05-PROCESSING-PIPELINE.md` §6's revision note.
 *
 * **T-RR-059.** `MetricsRegistry.incrementExternalSystemCall(systemCode, result)`
 * (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3) is called from `writeCallLog` below, the one call
 * site per resolved outcome that already has `connectorConfig.system_code` and `result.outcome` in
 * scope — mirroring `RewardIngestionService`'s own `@Optional() metrics?: MetricsRegistry`
 * precedent (T-RR-056) so the pre-existing, out-of-this-task's-scope direct
 * `new CoreBankingConnector(resolver, config)` construction sites (this class's own spec file,
 * `agent-rr-integration`'s own file scope) keep compiling unchanged. Incremented unconditionally
 * inside the same `try` block as the `INSERT`, and ordered *before* it — so a future
 * `external_system_call_log` write failure (caught and swallowed below, never propagated) cannot
 * silently suppress the metric increment that is meant to mirror it. `markDispatchedExternal` never
 * touched `MetricsRegistry` at all, so T-RR-067's fix to the row double-write above has no effect
 * on this metric.
 */
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import { MetricsRegistry, type ExternalCallResult } from '@/observability/metrics.registry';
import {
  ServiceConfigNotFoundError,
  ServiceConfigResolverService,
} from '@/modules/service-config/service-config-resolver.service';
import type { ServiceConfigScopeContext } from '@/modules/service-config/service-config-resolver.service';
import type {
  ClaimedRewardEntry,
  ExternalRewardSystemConfig,
  RedemptionResult,
  RewardSystemConnector,
} from './reward-system-connector.interface';

/** Maps `RedemptionResult['outcome']` to `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3's own
 * `external_system_call_total` `result` label values — an explicit, exhaustively-typed switch (not
 * a bare `.toLowerCase()` cast) so a future addition to `RedemptionResult`'s outcome union fails to
 * compile here instead of silently emitting an unlisted label value (same discipline
 * `RewardIngestionService.toMetricsChannel` already established for T-RR-056). */
function toMetricsResult(outcome: RedemptionResult['outcome']): ExternalCallResult {
  switch (outcome) {
    case 'SUCCESS':
      return 'success';
    case 'RETRYABLE_FAILURE':
      return 'retryable_failure';
    case 'PERMANENT_FAILURE':
      return 'permanent_failure';
    default: {
      // Exhaustiveness guard — `outcome` is a closed union at the type level (R2: no `any`).
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled RedemptionResult outcome: ${String(exhaustiveCheck)}`);
    }
  }
}

/** The one `service_config` key this stub's own canned outcome reads through (implementation
 * note 1) — never scoped narrower than this file needs, never hardcoded in a branch. */
export const CORE_BANKING_STUB_OUTCOME_CONFIG_KEY = 'connectors.coreBanking.stubOutcome';

/** Used only when `CORE_BANKING_STUB_OUTCOME_CONFIG_KEY` has no row at any scope — see this file's
 * own header for why this fallback exists instead of a migration-seeded `GLOBAL` row. Matches
 * implementation note 1's own instruction for what the seeded default *would* have been. */
export const DEFAULT_STUB_OUTCOME: RedemptionResult['outcome'] = 'SUCCESS';

const VALID_STUB_OUTCOMES: ReadonlyArray<RedemptionResult['outcome']> = [
  'SUCCESS',
  'RETRYABLE_FAILURE',
  'PERMANENT_FAILURE',
];

/**
 * Thrown when `service_config.connectors.coreBanking.stubOutcome` resolves to a string that is not
 * one of `RedemptionResult`'s three outcome literals (TC-8) — a data/config error surfaced loudly
 * at read time, never silently coerced to a specific outcome (implementation note 2's own "do not
 * invent a fourth stub-only state" applies with equal force to an invalid raw value).
 */
export class InvalidStubOutcomeError extends Error {
  constructor(public readonly rawValue: string) {
    super(
      `service_config key "${CORE_BANKING_STUB_OUTCOME_CONFIG_KEY}" resolved to ` +
        `${JSON.stringify(rawValue)}, which is not one of 'SUCCESS' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE'.`,
    );
    this.name = 'InvalidStubOutcomeError';
  }
}

function isValidStubOutcome(value: string): value is RedemptionResult['outcome'] {
  return (VALID_STUB_OUTCOMES as ReadonlyArray<string>).includes(value);
}

/** Plausible-not-arbitrary synthetic shapes (implementation note 2) — a future real integration
 * replaces this stub behind the identical `RewardSystemConnector` interface, so downstream code
 * (dispatch, notification) should never need to change shape assumptions when that day comes. */
function buildSuccessResult(): {
  externalReferenceId: string;
  responseSummary: Record<string, unknown>;
} {
  const transferId = `CB-${randomUUID()}`;
  return {
    externalReferenceId: transferId,
    responseSummary: { transferId, status: 'COMPLETED' },
  };
}

const RETRYABLE_STUB_ERROR_CODE = 'CORE_BANKING_STUB_TIMEOUT';
const PERMANENT_STUB_ERROR_CODE = 'CORE_BANKING_STUB_ACCOUNT_REJECTED';

/** R8/R9: never carries a plaintext `customerId` or a credential — `customer_id_hash` stands in
 * for the customer identity, and `endpointUrl` is the only "credential-adjacent" field logged,
 * which is itself not a secret (R9 governs `auth_secret_ref`'s resolved *value*, never dialed
 * here at all). */
function buildWouldBeRequestSummary(
  entry: ClaimedRewardEntry,
  connectorConfig: ExternalRewardSystemConfig,
): Record<string, unknown> {
  return {
    endpointUrl: connectorConfig.endpoint_url,
    method: 'POST',
    body: {
      correlationId: entry.correlation_id,
      tenantId: String(entry.tenant_id),
      rewardEntryId: entry.id,
      customerIdHash: entry.customer_id_hash,
      merchantId: entry.merchant_code ?? '',
      amount: entry.activity_value,
      currency: entry.activity_value_unit,
    },
  };
}

@Injectable()
export class CoreBankingConnector implements RewardSystemConnector, OnModuleDestroy {
  private readonly logger = new Logger(CoreBankingConnector.name);
  private readonly pool: Pool;

  constructor(
    private readonly serviceConfig: ServiceConfigResolverService,
    config: ConfigService<Config, true>,
    @Optional() pool?: Pool,
    /**
     * Optional (`@Optional()`) purely so the pre-existing, out-of-this-task's-scope direct
     * `new CoreBankingConnector(...)` construction sites (this class's own spec file) keep
     * compiling unchanged. Every real, Nest-DI-resolved construction path
     * (`CoreBankingConnectorModule` importing `ObservabilityModule`) always supplies a real
     * instance; `writeCallLog` below only skips the increment if this is genuinely absent.
     */
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {
    this.pool =
      pool ??
      new Pool({
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        user: config.get('DB_APP_USERNAME', { infer: true }),
        password: config.get('DB_APP_PASSWORD', { infer: true }),
        ssl: config.get('DB_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      });
  }

  async redeem(
    entry: ClaimedRewardEntry,
    connectorConfig: ExternalRewardSystemConfig,
  ): Promise<RedemptionResult> {
    const attemptNumber = entry.retry_count + 1;
    const startedAt = Date.now();

    // Deliberately resolved (and allowed to throw InvalidStubOutcomeError) before any "would-be
    // request" is built or logged — a bad config value is a configuration bug, not a redemption
    // outcome, and must never be silently reduced to one (TC-8).
    const outcome = await this.resolveStubOutcome(entry);

    const requestSummary = buildWouldBeRequestSummary(entry, connectorConfig);
    this.logger.log({
      message: 'CoreBankingConnector stub: logging the request a real call would have sent',
      rewardEntryId: entry.id,
      correlationId: entry.correlation_id,
      tenantId: entry.tenant_id,
      campaignCode: entry.campaign_code,
      systemCode: connectorConfig.system_code,
      attemptNumber,
      ...requestSummary,
    });

    const result = this.buildResult(outcome);
    const responseSummary = result.outcome === 'SUCCESS' ? result.responseSummary : null;
    const latencyMs = Date.now() - startedAt;

    await this.writeCallLog(
      entry,
      connectorConfig,
      attemptNumber,
      requestSummary,
      responseSummary,
      result,
      latencyMs,
    );

    return result;
  }

  /** Implementation note 1: `CAMPAIGN` → `TENANT` → `COUNTRY` → `GLOBAL` precedence, exactly
   * `ServiceConfigResolverService`'s own walk — a future test scenario can override this stub's
   * canned outcome for one specific campaign/tenant/country without touching any other entry's
   * resolution. */
  private async resolveStubOutcome(
    entry: ClaimedRewardEntry,
  ): Promise<RedemptionResult['outcome']> {
    const context: ServiceConfigScopeContext = {
      campaignCode: entry.campaign_code,
      tenantCode: entry.tenant_code ?? undefined,
      countryCode: entry.country_code ?? undefined,
    };

    let raw: string;
    try {
      raw = await this.serviceConfig.resolve(
        CORE_BANKING_STUB_OUTCOME_CONFIG_KEY,
        'string',
        context,
      );
    } catch (error) {
      if (error instanceof ServiceConfigNotFoundError) {
        this.logger.warn(
          `service_config key "${CORE_BANKING_STUB_OUTCOME_CONFIG_KEY}" is not seeded for this ` +
            `context — using default outcome "${DEFAULT_STUB_OUTCOME}".`,
        );
        return DEFAULT_STUB_OUTCOME;
      }
      // Anything else (e.g. ServiceConfigTypeError) is a genuine data/config error, not an
      // "unseeded" gap — must propagate, never silently coerced into a canned outcome.
      throw error;
    }

    if (!isValidStubOutcome(raw)) {
      throw new InvalidStubOutcomeError(raw);
    }
    return raw;
  }

  private buildResult(outcome: RedemptionResult['outcome']): RedemptionResult {
    switch (outcome) {
      case 'SUCCESS':
        return { outcome: 'SUCCESS', ...buildSuccessResult() };
      case 'RETRYABLE_FAILURE':
        return {
          outcome: 'RETRYABLE_FAILURE',
          errorCode: RETRYABLE_STUB_ERROR_CODE,
          errorMessage: 'CoreBankingConnector stub: configured to return a retryable failure',
        };
      case 'PERMANENT_FAILURE':
        return {
          outcome: 'PERMANENT_FAILURE',
          errorCode: PERMANENT_STUB_ERROR_CODE,
          errorMessage: 'CoreBankingConnector stub: configured to return a permanent failure',
        };
      default: {
        // Exhaustiveness guard — `outcome` is a closed union at the type level (R2: no `any`).
        const exhaustiveCheck: never = outcome;
        throw new InvalidStubOutcomeError(String(exhaustiveCheck));
      }
    }
  }

  /** `01-DATABASE.md` §9, implementation note 4 — written for every resolved outcome, `latency_ms`
   * reflecting real (near-zero) elapsed time only, never a synthetic delay. */
  private async writeCallLog(
    entry: ClaimedRewardEntry,
    connectorConfig: ExternalRewardSystemConfig,
    attemptNumber: number,
    requestSummary: Record<string, unknown>,
    responseSummary: Record<string, unknown> | null,
    result: RedemptionResult,
    latencyMs: number,
  ): Promise<void> {
    const errorCode = result.outcome === 'SUCCESS' ? null : result.errorCode;
    try {
      // T-RR-059: incremented unconditionally, ahead of the INSERT below, so a subsequent
      // call-log write failure (caught and swallowed, never propagated) cannot suppress the
      // metric that is meant to mirror it — see this file's own header.
      this.metrics?.incrementExternalSystemCall(
        connectorConfig.system_code,
        toMetricsResult(result.outcome),
      );
      await this.pool.query(
        `INSERT INTO reward_redemption.external_system_call_log
           (reward_entry_id, system_code, attempt_number, request_summary, response_summary,
            result, error_code, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.id,
          connectorConfig.system_code,
          attemptNumber,
          JSON.stringify(requestSummary),
          responseSummary ? JSON.stringify(responseSummary) : null,
          result.outcome,
          errorCode,
          latencyMs,
        ],
      );
    } catch (error) {
      // Observability write failure must never mask (or throw over) the connector's own real
      // outcome — same discipline PromoCodeServiceConnector's own writeCallLog documents.
      this.logger.warn(
        `Failed to write external_system_call_log for reward_entry_id=${entry.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
