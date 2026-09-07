/**
 * T-RR-024. `RedemptionProcessingOrchestrator` — the per-claimed-row driver
 * (`05-PROCESSING-PIPELINE.md` §1's five steps, minus the claim itself, T-RR-020's own job): resolve
 * → call the resolved connector (if any) → transition, with bounded retry attempts backed by
 * exponential backoff and a `reward_redemption_failed` write on exhaustion.
 *
 * **A documented cross-wave correction, recorded here per `AGENT-PROTOCOL.md` §3's "the design doc
 * wins ... note the conflict in your completion report".** This task's own file predates Wave 3 and
 * describes the flow as "call a connector ... passes the outcome to T-RR-023's classifier" — as if
 * this orchestrator itself ran `RetryClassificationService.classify()` on a raw connector outcome.
 * `08-EXTERNAL-INTEGRATION-CONTRACTS.md` §1 (the authoritative design doc, and the interface
 * T-RR-030 already built — see below) is explicit that classification is the *connector's own job*:
 * "a connector's own job is to map whatever transport/business error it actually encountered into
 * exactly one of `RedemptionResult`'s three outcomes ... the pipeline itself never inspects a
 * connector-specific error shape directly — it only ever sees `SUCCESS`/`RETRYABLE_FAILURE`/
 * `PERMANENT_FAILURE`." This orchestrator therefore does **not** call `RetryClassificationService
 * .classify()` at all (a connector implementation, Wave 3, calls it internally if it chooses to, to
 * apply the two-tier model against its own resolved `retryable_error_codes`) — it only reuses this
 * task's own `computeBackoffDelayMs()` (a pure function of `retryCount`/backoff config, not a
 * classification decision) to schedule the next attempt once a `RETRYABLE_FAILURE` outcome is
 * already in hand. This is consistent with this task's own test cases (TC-3/TC-4/TC-5 all describe
 * the connector's outcome as already "classified retryable"/"classified permanent" — a property
 * *given* to this orchestrator, never one it derives itself).
 *
 * **`RewardSystemConnector`/`RedemptionResult` are imported from T-RR-030's own file
 * (`@/modules/connectors/reward-system-connector.interface`), not re-declared here.** This task's own
 * "Files owned" list still carries a placeholder copy at
 * `src/modules/processing/reward-system-connector.interface.ts` (this task predates Wave 3, and that
 * placeholder was meant to be "adopted as-is or superseded" by whichever of this task or T-RR-030 ran
 * first, per this task's own implementation note 1) — by the time this task actually ran, T-RR-030
 * had already landed (`review` status in `progress.json`) with the exact shape this task's own note
 * anticipated. That file now only re-exports T-RR-030's real types, so there is exactly one
 * definition of this interface, never two that could silently drift apart.
 *
 * **T-RR-057.** `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3's `reward_redemptions_completed_total`/
 * `reward_redemptions_failed_total` had no call site anywhere in the tree (defect evidence, filed
 * from T-RR-040's own audit). This is one of the two files that own every terminal transition this
 * orchestrator itself drives directly — `markCompletedDirect` (the no-connector `-> completed` path)
 * and both `markFailed` call sites (permanent failure, retry exhaustion) — so the corresponding
 * `MetricsRegistry` increment is recorded here, immediately after each call *resolves*, never before
 * (never speculative, never on a caught error — if the state-machine call throws, execution never
 * reaches the increment line, since `await` re-throws synchronously into this method's own caller).
 * The `SUCCESS` branch (`markDispatchedExternal`) deliberately does **not** increment
 * `reward_redemptions_completed_total` here — that branch reaches `dispatched_external`, not
 * `completed`; the increment for that eventual transition belongs where `completeDispatched` is
 * actually called (today, only `CompletionSweepService`, T-RR-021 — see that file's own T-RR-057
 * note).
 *
 * **T-RR-063.** Both terminal transitions this orchestrator drives directly
 * (`markCompletedDirect`/`markDispatchedExternal`) now also receive a computed `expiresAt`: a fresh
 * `const nowUtc = new Date()`, taken immediately before each call (never shared across the two
 * branches — the `SUCCESS` branch's own instant is *after* `connector.redeem()` resolves, which can
 * be an arbitrary network hop, so reusing an earlier `nowUtc` there would anchor the expiry to the
 * wrong instant), fed into `computeExpiresAt()` (`expiry-computation.ts`) alongside
 * `resolvedReward.expiryValue`/`expiryUnit` (`RewardSystemResolutionService`, T-RR-022/T-173).
 * `resolvedReward` is already resolved once per call and reused for both branches — this is not a
 * second lookup.
 *
 * **T-RR-065 (defect fix).** `06-CACHING-AND-TENANT-CONFIG.md` §5's claim-time `tenant_code`/
 * `country_code` enrichment step ("immediately after a row is claimed ... before §4's
 * reward-system resolution") had no call site anywhere in this service — every entry reached
 * `dispatched_external`/`completed` with both columns still `NULL`, which made
 * `RewardTrackingOutboxRepository.buildOutboxPayload` throw unconditionally the moment
 * `RedemptionCompletionSideEffects` (T-RR-061) became the bound side-effects implementation, and
 * silently violated `ClaimedRewardEntry`'s own documented contract for every connector call in the
 * meantime (`core-banking.connector.ts` already reads `entry.tenant_code`/`entry.country_code`).
 * `processClaimedEntry` now runs `TenantSchemaEnrichmentService.enrich()` as its first step,
 * reassigning its own local `entry` to the enriched row before anything else (§4's resolution, the
 * connector call, and every state-machine transition) ever sees it — exactly the ordering §5
 * specifies.
 *
 * **`tenantSchemaEnrichment` is `@Optional()`, not a hard constructor requirement, deliberately.**
 * Every real deployment path (`ClaimWorkerModule`, which imports `ProcessingModule`) always
 * supplies a real instance via Nest DI — this is a belt only, not the buckle. The buckle is
 * `TenantSchemaEnrichmentService.enrich()`'s own idempotent short-circuit: an entry that already
 * carries non-`NULL` `tenant_code`/`country_code` never touches this dependency at all, which is
 * exactly the case `test/e2e/observability.e2e-spec.ts` (`agent-rr-qa`'s own file, out of this
 * task's scope, R3) relies on — it constructs this orchestrator directly with a fixed
 * six-argument list predating this task, after stamping both columns itself via direct SQL (its
 * own documented T-RR-065 workaround). Making the seventh parameter required would be a breaking
 * change to a file this task cannot edit; making it `@Optional()` preserves that file's own
 * six-argument construction untouched while still enforcing the invariant loudly (a clear, named
 * error, not `buildOutboxPayload`'s generic one) for any real caller that reaches this step
 * without it.
 *
 * **T-RR-067 (defect fix).** `RedemptionStateMachineService.markDispatchedExternal`
 * (`redemption-state-machine.service.ts`) used to insert its own `external_system_call_log` row
 * for the `SUCCESS` branch below, using a thinner `request_summary` this orchestrator built itself.
 * Every real connector (`PromoCodeServiceConnector`/`CoreBankingConnector`, Wave 3) *also*
 * unconditionally writes its own `external_system_call_log` row for every attempt it makes,
 * `SUCCESS` included, before ever returning its `RedemptionResult` here — so once a real connector
 * was wired in (this task), a single successful attempt wrote two rows for the same attempt.
 * Reproduced and root-caused by T-RR-041, fixed here and in `redemption-state-machine.service.ts`:
 * this orchestrator no longer passes `attemptNumber`/`requestSummary`/`responseSummary`/`latencyMs`
 * to `markDispatchedExternal` at all, and that method no longer writes to
 * `external_system_call_log` — the connector that made the call is now that row's sole writer,
 * for every outcome uniformly. See `05-PROCESSING-PIPELINE.md` §6's own revision note.
 */
import { Injectable, Optional } from '@nestjs/common';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type {
  RedemptionResult,
  RewardSystemConnector,
} from '@/modules/connectors/reward-system-connector.interface';
import { ConnectorRegistry } from '@/modules/connectors/connector-registry';
import { ExternalRewardSystemConfigResolver } from '@/modules/reward-system-config/external-reward-system-config.resolver';
import { RetryClassificationService } from '@/modules/reward-system-config/retry-classification.service';
import {
  RedemptionStateMachineService,
  type MarkFailedInput,
} from '@/modules/redemption/redemption-state-machine.service';
import { MetricsRegistry } from '@/observability/metrics.registry';
import {
  RewardSystemResolutionService,
  TenantSchemaEnrichmentService,
} from './reward-system-resolution.service';
import { computeExpiresAt } from './expiry-computation';

/**
 * Deliberately narrower than `RewardSystemConnector` itself — this orchestrator never needs to
 * *register* a connector, only *resolve and call* one, so it depends only on the read side of the
 * registry (keeps this file's own test doubles minimal, R2).
 */
export interface ConnectorResolver {
  resolve(connectorType: string): RewardSystemConnector;
}

@Injectable()
export class RedemptionProcessingOrchestrator {
  constructor(
    private readonly resolutionService: RewardSystemResolutionService,
    private readonly configResolver: ExternalRewardSystemConfigResolver,
    private readonly retryClassification: RetryClassificationService,
    private readonly connectorRegistry: ConnectorRegistry,
    private readonly stateMachine: RedemptionStateMachineService,
    private readonly metrics: MetricsRegistry,
    // T-RR-065: `@Optional()` deliberately — see this file's own header note on why this stays a
    // seventh, non-breaking parameter rather than a required one.
    @Optional() private readonly tenantSchemaEnrichment?: TenantSchemaEnrichmentService,
  ) {}

  /**
   * Drives one already-claimed row (T-RR-020's own job ends at `processing`) through
   * `05-PROCESSING-PIPELINE.md` §4-§7 and returns the row as it stands after whichever transition
   * this call drove — `dispatched_external` (TC-1), `completed` directly (TC-2), `retrying` (TC-3),
   * or `failed` (TC-4/TC-5).
   */
  async processClaimedEntry(
    claimedEntry: RewardRedemptionEntryRow,
  ): Promise<RewardRedemptionEntryRow> {
    // T-RR-065: `06-CACHING-AND-TENANT-CONFIG.md` §5's claim-time enrichment step runs first,
    // before any of §4-§7 below ever sees this row — every later reference to `entry` in this
    // method (the resolution lookups, the connector call, every state-machine transition) uses the
    // enriched row, never `claimedEntry` directly.
    const entry = await this.enrichTenantSchema(claimedEntry);

    const resolvedReward = await this.resolutionService.resolve({
      tenantId: entry.tenant_id,
      campaignCode: entry.campaign_code,
      trackerCode: entry.tracker_code,
      trackerComponentCode: entry.tracker_component_code,
      rewardCode: entry.reward_code,
    });

    const connectorConfig = await this.configResolver.resolve(
      resolvedReward.systemCode,
      entry.tenant_id,
    );

    if (!connectorConfig) {
      // §4 point 2 / §2's table: no active connector-config row resolves for this system_code —
      // "genuinely nothing to call" is the direct `-> completed` path (TC-2). The connector
      // interface is never touched on this branch.
      // T-RR-063: `nowUtc` is this transition's own redemption instant — computed here, right
      // before the write, not reused from any earlier point in this method.
      const nowUtc = new Date();
      const expiresAt = computeExpiresAt(
        nowUtc,
        resolvedReward.expiryValue ?? null,
        resolvedReward.expiryUnit ?? null,
      );
      const completed = await this.stateMachine.markCompletedDirect(entry.id, expiresAt);
      // T-RR-057: this *is* the direct no-external-call `-> completed` path §3 explicitly calls
      // out — increment only now that the write has actually committed.
      this.metrics.incrementRewardRedemptionsCompleted(resolvedReward.systemCode);
      return completed;
    }

    const connector = this.connectorRegistry.resolve(connectorConfig.connector_type);

    // `entry.retry_count` counts *prior* failed attempts only (0 on a first-ever attempt) — the
    // attempt about to happen is always one more than that, matching
    // `RetryClassificationService.computeBackoffDelayMs`'s own documented convention ("retry_count
    // = 3 means the third retry") and `05-PROCESSING-PIPELINE.md` §7's `total_attempts` field.
    const attemptNumber = entry.retry_count + 1;

    // `05-PROCESSING-PIPELINE.md` §3/§8's emphatic rule: no transaction or advisory lock is open
    // across this call. Everything above this line is a cached lookup (no DB write of its own);
    // everything below opens its own fresh, short transaction (inside the state-machine methods
    // this orchestrator calls into) only after this call has already resolved (TC-6).
    const result: RedemptionResult = await connector.redeem(entry, connectorConfig);

    if (result.outcome === 'SUCCESS') {
      // T-RR-067 (defect fix): no `attemptNumber`/`requestSummary`/`responseSummary`/`latencyMs`
      // passed here any more — `markDispatchedExternal` no longer writes its own
      // `external_system_call_log` row (the connector that just returned `result` already wrote
      // its own, unconditionally, before returning — see that method's own doc comment).
      // T-RR-063: `nowUtc` computed only now, after `connector.redeem()` has already resolved —
      // that call can be an arbitrary network hop, so it must not anchor the expiry to an instant
      // taken before it (this file's own header note).
      const nowUtc = new Date();
      const expiresAt = computeExpiresAt(
        nowUtc,
        resolvedReward.expiryValue ?? null,
        resolvedReward.expiryUnit ?? null,
      );
      return this.stateMachine.markDispatchedExternal({
        entryId: entry.id,
        externalSystemCode: connectorConfig.system_code,
        externalReferenceId: result.externalReferenceId,
        expiresAt,
      });
    }

    if (result.outcome === 'PERMANENT_FAILURE') {
      // §7: a permanent failure is terminal on any attempt, first or otherwise (TC-5).
      return this.markFailedAndRecordMetric(
        entry.id,
        attemptNumber,
        result,
        connectorConfig.system_code,
      );
    }

    // RETRYABLE_FAILURE. Bounded by this system's own resolved `max_retry_attempts` (§5/§7) —
    // exhaustion is a `failed` transition, never another `retrying` one (TC-4).
    if (attemptNumber >= connectorConfig.max_retry_attempts) {
      return this.markFailedAndRecordMetric(
        entry.id,
        attemptNumber,
        result,
        connectorConfig.system_code,
      );
    }

    const delayMs = this.retryClassification.computeBackoffDelayMs(
      attemptNumber,
      connectorConfig.retry_backoff_base_ms,
      connectorConfig.retry_backoff_max_ms,
    );
    return this.stateMachine.markRetrying({
      entryId: entry.id,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      delayMs,
    });
  }

  /** Both `markFailed` call sites (permanent failure, retry exhaustion) share this: write the
   * `failed` transition, then — only once that write has actually committed — increment
   * `reward_redemptions_failed_total{system_code}` (T-RR-057). `system_code` is the caller's
   * already-resolved `connectorConfig.system_code`, the same value `05-PROCESSING-PIPELINE.md` §7's
   * `reward_redemption_failed` row and `external_system_call_log` are both keyed on. */
  private async markFailedAndRecordMetric(
    entryId: string,
    attemptNumber: number,
    result: Extract<RedemptionResult, { outcome: 'PERMANENT_FAILURE' | 'RETRYABLE_FAILURE' }>,
    systemCode: string,
  ): Promise<RewardRedemptionEntryRow> {
    const failed = await this.stateMachine.markFailed(
      this.buildFailedInput(entryId, attemptNumber, result),
    );
    this.metrics.incrementRewardRedemptionsFailed(systemCode);
    return failed;
  }

  private buildFailedInput(
    entryId: string,
    attemptNumber: number,
    result: Extract<RedemptionResult, { outcome: 'PERMANENT_FAILURE' | 'RETRYABLE_FAILURE' }>,
  ): MarkFailedInput {
    return {
      entryId,
      totalAttempts: attemptNumber,
      finalErrorCode: result.errorCode,
      finalErrorMessage: result.errorMessage,
    };
  }

  /**
   * T-RR-065. `06-CACHING-AND-TENANT-CONFIG.md` §5's claim-time enrichment step, run once per
   * `processClaimedEntry` call, before anything else in it. `TenantSchemaEnrichmentService.enrich()`
   * is itself idempotent (an already-enriched row is returned unchanged, no dependency touched at
   * all) — the `@Optional()` fallback here only ever matters for an entry that reaches this method
   * still unenriched with no `TenantSchemaEnrichmentService` wired in, which is a real
   * misconfiguration this orchestrator will not silently paper over (this file's own header note
   * explains why the dependency is optional in the first place).
   */
  private async enrichTenantSchema(
    entry: RewardRedemptionEntryRow,
  ): Promise<RewardRedemptionEntryRow> {
    if (entry.tenant_code !== null && entry.country_code !== null) {
      return entry;
    }
    if (!this.tenantSchemaEnrichment) {
      throw new Error(
        `reward_redemption_entry ${entry.id} has no tenant_code/country_code and no ` +
          'TenantSchemaEnrichmentService was provided to enrich it (06-CACHING-AND-TENANT-CONFIG.md ' +
          '§5) — this is a wiring defect, never a condition to silently proceed past.',
      );
    }
    return this.tenantSchemaEnrichment.enrich(entry);
  }
}
