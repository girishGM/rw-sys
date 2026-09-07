/**
 * T-RR-031. `PromoCodeServiceConnector` — the one real `RewardSystemConnector` implementation
 * this plan ships (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §2, `ARCHITECTURE.md` §8). Calls
 * promo-code-service's real `POST /api/v1/promo-codes/generate` (`04-REST-CONTRACT.md` §2) and
 * reduces every outcome — transport-level or in-body business rejection — to exactly one of
 * `RedemptionResult`'s three outcomes.
 *
 * **`bindLevel`/`bindRefId` mapping — a documented T-RR-031 decision, not a value this doc pins
 * down.** `04-REST-CONTRACT.md` §2's own worked example shows `bindRefId` as a portal-internal
 * numeric id (confirmed against `promo-code-service-plan/04-API-CONTRACT.md` §2: "portal-sourced
 * ids... `reward_portal`'s own numeric/varchar ids"), and *which* level (`CAMPAIGN`/`TRACKER`/
 * `COMPONENT`) a given reward's promo-code binding was actually made at is recorded only on the
 * portal's own cached feed (`campaign_config.v1.proto`'s `BoundReward.level`/`ref_id`, added by
 * `project-plan/T-047`) — a piece of data `05-PROCESSING-PIPELINE.md` §4's campaign/reward
 * resolution step (T-RR-022, not a dependency of this task and not yet done) does not thread
 * through to `ClaimedRewardEntry` today. `reward_redemption_entry` (`01-DATABASE.md` §1) itself
 * carries no bind-level/portal-ref-id column at all, and R5 forbids this service from storing a
 * portal-internal numeric id even if it did. Rather than block this task on that still-missing
 * plumbing, this connector always sends `bindLevel: 'CAMPAIGN'` and `bindRefId: entry.campaign_code`
 * — the one identifier `ClaimedRewardEntry` always carries that names the right *campaign*, even
 * though it is a code, not the portal's numeric id, and even though a reward actually bound at
 * `TRACKER`/`COMPONENT` level would legitimately fail to resolve on promo-code-service's own side
 * until that plumbing lands. `merchantId` has the identical portal-id/code mismatch (§2's example
 * shows a numeric-looking merchant id; this row only carries `merchant_code`) and is resolved the
 * same way: send the code this service actually has, coerced to `''` when `NULL`. Flagged in this
 * task's own completion report per `AGENT-PROTOCOL.md` §3 ("if you find a genuine design flaw...
 * implement to spec, flag the flaw... let the architect decide") — the real fix is threading
 * `BoundReward.level`/`ref_id` through T-RR-022's resolution step once it lands, not something
 * this connector can invent from data it was never given.
 *
 * **`external_system_call_log` double-write — reported as T-RR-067, fixed there.** Implementation
 * note 5 requires this connector to write its own `external_system_call_log` row for every attempt,
 * including `SUCCESS` — still true, unchanged by that fix. `RedemptionStateMachineService
 * .markDispatchedExternal` (T-RR-021) used to *also* insert a row into the same table on every
 * `SUCCESS` transition; once `RedemptionProcessingOrchestrator` (T-RR-024) wired a real connector
 * to that method for real, a single successful attempt wrote two rows. T-RR-067 (reproduced and
 * root-caused by T-RR-041) resolved this by removing the second write from
 * `markDispatchedExternal` instead of from here: this connector's own unconditional, every-outcome
 * write (this method) is the only remaining `external_system_call_log` writer for a connector-made
 * call, `SUCCESS` included. See `redemption-state-machine.service.ts`'s own `MarkDispatchedExternalInput`
 * doc comment and `05-PROCESSING-PIPELINE.md` §6's revision note for the full reasoning.
 *
 * No transaction, no advisory lock threaded through this method (`05-PROCESSING-PIPELINE.md` §3) —
 * this class only ever opens its own short-lived pool queries for the call-log write, never
 * receives or opens a `sequelize`/`pg` transaction spanning the HTTP call itself.
 *
 * **T-RR-059.** `MetricsRegistry.incrementExternalSystemCall(systemCode, result)`
 * (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3) is called from `writeCallLog` below, the one call
 * site per resolved outcome that already has `connectorConfig.system_code` and `result.outcome` in
 * scope — mirroring `RewardIngestionService`'s own `@Optional() metrics?: MetricsRegistry`
 * precedent (T-RR-056) so the pre-existing, out-of-this-task's-scope direct
 * `new PromoCodeServiceConnector(encryption, config)` construction sites (this class's own spec
 * file, `agent-rr-integration`'s own file scope) keep compiling unchanged. Incremented
 * unconditionally inside the same `try` block as the `INSERT`, and ordered *before* it — so a
 * future `external_system_call_log` write failure (caught and swallowed below, never propagated)
 * cannot silently suppress the metric increment that is meant to mirror it. T-RR-067's fix to the
 * double-write flagged in this file's own header note above never touched `MetricsRegistry` at
 * all — `markDispatchedExternal` never incremented this counter itself, so removing its row insert
 * has no effect on this metric; this call site remains the single, unchanged place `external_
 * system_call_total{result:"success"}` increments.
 *
 * **T-RR-080.** `redeem()` now resolves a REST-vs-gRPC channel via the optional, DI-injected
 * `PromoCodeChannelResolverService`/`PromoCodeServiceGrpcClient` pair (both `@Optional()`, same
 * back-compat precedent as `metrics` above — every pre-existing bare `new
 * PromoCodeServiceConnector(encryption, config, ...)` construction site keeps compiling and keeps
 * its exact prior REST-only behavior unchanged, since `performCall` treats "no resolver wired"
 * identically to "resolved to REST"). See `promo-code-service-grpc.client.ts`'s own header for a
 * documented deviation from this task's own implementation note 2 (gRPC auth is mTLS, not
 * `GENERATION_SERVICE_TOKEN` — confirmed by direct read of the real, already-built server side).
 * `performCall`'s own header documents the tier-selection algorithm actually implemented.
 */
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { MetricsRegistry, type ExternalCallResult } from '@/observability/metrics.registry';
import type {
  ClaimedRewardEntry,
  ExternalRewardSystemConfig,
  RedemptionResult,
  RewardSystemConnector,
} from './reward-system-connector.interface';
import type {
  PromoCodeGenerateRequest,
  PromoCodeGenerateResponse,
} from './promo-code-service.connector.types';
import {
  PromoCodeChannelResolverService,
  type ResolvedPromoCodeChannel,
} from './promo-code-channel-resolver.service';
import { PromoCodeServiceGrpcClient } from './promo-code-service-grpc.client';
import {
  PromoCodeServiceKafkaClient,
  type PromoCodeGenerateRequestData,
  type PromoCodeGenerateResultData,
} from './promo-code-service-kafka.client';
import { PromoCodeKafkaReplyTimeoutError } from './promo-code-kafka-request-reply.registry';

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

/** Not named by any design doc (same "not pinned down, flagged as an assumption" precedent
 * `reward-tracking-rest.client.ts`'s own header sets for its base-URL/timeout vars) — a bounded
 * per-call timeout so a hung promo-code-service call can never hold this connector open
 * indefinitely. */
export const PROMO_CODE_SERVICE_CALL_TIMEOUT_MS = 5_000;

/**
 * Thrown when `connectorConfig.auth_secret_ref` names an environment variable that is unset or
 * blank at call time — a connector-config error (misconfigured `auth_secret_ref`, R9's own storage
 * rule: the row holds only the *name*, never the value), never itself the credential value. Caught
 * inside `redeem()` and reduced to a `PERMANENT_FAILURE` (a missing secret cannot be fixed by
 * retrying), never allowed to propagate as an unhandled rejection.
 */
export class MissingAuthSecretError extends Error {
  constructor(public readonly authSecretRef: string) {
    super(
      `Missing or blank environment variable "${authSecretRef}" — ` +
        `external_reward_system_config.auth_secret_ref names an env var that resolves to no value`,
    );
    this.name = 'MissingAuthSecretError';
  }
}

/** R9: resolves the *value* of the env var named by `authSecretRef` at call time — never stores
 * or caches the resolved value beyond the caller's own single-call stack frame. */
function resolveAuthSecretValue(authSecretRef: string): string {
  const value = process.env[authSecretRef];
  if (!value || value.trim().length === 0) {
    throw new MissingAuthSecretError(authSecretRef);
  }
  return value;
}

/** R8/R9: never carries `Authorization`, the resolved secret value, or a plaintext `customerId` —
 * `customer_id_hash` stands in for the customer identity instead. */
function buildRequestSummary(
  request: PromoCodeGenerateRequest,
  customerIdHash: string,
): Record<string, unknown> {
  const { customerId: _customerId, ...rest } = request;
  return { ...rest, customerIdHash };
}

function buildRequestBody(
  entry: ClaimedRewardEntry,
  decryptedCustomerId: string,
): PromoCodeGenerateRequest {
  return {
    correlationId: entry.correlation_id,
    tenantId: String(entry.tenant_id),
    // See this file's own header note on the bindLevel/bindRefId mapping decision.
    bindLevel: 'CAMPAIGN',
    bindRefId: entry.campaign_code,
    customerId: decryptedCustomerId,
    merchantId: entry.merchant_code ?? '',
    activityContext: {
      amount: entry.activity_value,
      currency: entry.activity_value_unit,
      metadataJson: '{}',
    },
  };
}

/**
 * T-RR-081. Maps the already-built, REST/gRPC-shaped `PromoCodeGenerateRequest` (`buildRequestBody`
 * above) to the Kafka contract's own `data` shape (`promo-code-service-plan/02-KAFKA-CONTRACTS.md`
 * §3) — same field values throughout (this connector still always sends `bindLevel: 'CAMPAIGN'`/
 * `bindRefId: entry.campaign_code`, this file's own header note), only the wire shape differs:
 * `metadataJson` (a pre-serialized string, always `'{}'` today) becomes `metadata` (a parsed
 * object), and `correlationId`/`tenantId` are dropped here since the Kafka envelope already carries
 * both (§2). Falls back to `{}` if `metadataJson` were ever something `JSON.parse` rejects — never
 * throws building a request.
 */
function toKafkaRequestData(request: PromoCodeGenerateRequest): PromoCodeGenerateRequestData {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(request.activityContext.metadataJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    // `metadataJson` is always `'{}'` today (`buildRequestBody` above) — defensive only.
  }
  return {
    bindLevel: request.bindLevel,
    bindRefId: request.bindRefId,
    customerId: request.customerId,
    merchantId: request.merchantId,
    activityContext: {
      amount: request.activityContext.amount,
      currency: request.activityContext.currency,
      metadata,
    },
  };
}

interface CallOutcome {
  result: RedemptionResult;
  responseSummary: Record<string, unknown> | null;
}

/**
 * T-RR-080. The transport-agnostic half of `08-EXTERNAL-INTEGRATION-CONTRACTS.md` §2's mapping —
 * "HTTP `200`, `status: 'FAILED'`" in the REST-specific doc language, but really "a *completed*
 * call, whichever transport made it" (`03-GRPC-CONTRACT.md` §5's own "a business outcome is not a
 * protocol-level fault" convention is the identical rule stated from the gRPC side). Extracted so
 * `callAndClassify` (REST) and `callAndClassifyGrpc` (gRPC) share exactly one classification path —
 * a completed `PromoCodeGenerateResponse`/`GenerateCodeResponse` (structurally identical, per this
 * service's own `promo_code_generation.proto` header) always reduces to the same `RedemptionResult`
 * regardless of which transport produced it, never two independently-maintained copies of the same
 * list-membership check that could drift (R7).
 */
function classifyGenerateResponseBody(
  body: PromoCodeGenerateResponse | null,
  connectorConfig: ExternalRewardSystemConfig,
): CallOutcome {
  if (!body || (body.status !== 'SUCCESS' && body.status !== 'FAILED')) {
    return {
      result: {
        outcome: 'PERMANENT_FAILURE',
        errorCode: 'MALFORMED_RESPONSE_BODY',
        errorMessage: 'promo-code-service returned an unparseable/unexpected response body',
      },
      responseSummary: body as unknown as Record<string, unknown> | null,
    };
  }

  if (body.status === 'SUCCESS') {
    return {
      result: {
        outcome: 'SUCCESS',
        externalReferenceId: body.promoCodeId,
        responseSummary: body as unknown as Record<string, unknown>,
      },
      responseSummary: body as unknown as Record<string, unknown>,
    };
  }

  // status === 'FAILED'. List-membership only — never a hardcoded per-code branch (R7).
  const errorCode = body.errorCode && body.errorCode.length > 0 ? body.errorCode : null;
  const retryable = errorCode !== null && connectorConfig.retryable_error_codes.includes(errorCode);
  return {
    result: {
      outcome: retryable ? 'RETRYABLE_FAILURE' : 'PERMANENT_FAILURE',
      errorCode,
      errorMessage: body.errorMessage,
    },
    responseSummary: body as unknown as Record<string, unknown>,
  };
}

/**
 * T-RR-081. Bridges `PromoCodeGenerateResultData`'s own nullable-field convention
 * (`promo-code-service-plan/02-KAFKA-CONTRACTS.md` §5 — `errorCode`/`errorMessage: null` on
 * `SUCCESS`, and the reward-shape fields `null` on `FAILED`) to `PromoCodeGenerateResponse`'s
 * always-present-empty-string convention (`promo-code-service.connector.types.ts`'s own header,
 * the REST/gRPC shape) — so `classifyGenerateResponseBody` above stays the single shared
 * classification path across all three transports (this file's own T-RR-080 header note), never a
 * second, independently-maintained copy of the same list-membership check (R7).
 */
function normalizeKafkaResultData(data: PromoCodeGenerateResultData): PromoCodeGenerateResponse {
  return {
    status: data.status,
    promoCodeId: data.promoCodeId ?? '',
    code: data.code ?? '',
    rewardValueType: data.rewardValueType ?? '',
    rewardValue: data.rewardValue ?? '',
    rewardUnit: data.rewardUnit ?? '',
    expiresAt: data.expiresAt ?? '',
    errorCode: data.errorCode ?? '',
    errorMessage: data.errorMessage ?? '',
  };
}

@Injectable()
export class PromoCodeServiceConnector implements RewardSystemConnector, OnModuleDestroy {
  private readonly logger = new Logger(PromoCodeServiceConnector.name);
  private readonly pool: Pool;

  constructor(
    private readonly encryption: EncryptionService,
    config: ConfigService<Config, true>,
    @Optional() pool?: Pool,
    /**
     * Optional (`@Optional()`) purely so the pre-existing, out-of-this-task's-scope direct
     * `new PromoCodeServiceConnector(...)` construction sites (this class's own spec file) keep
     * compiling unchanged. Every real, Nest-DI-resolved construction path
     * (`PromoCodeServiceConnectorModule` importing `ObservabilityModule`) always supplies a real
     * instance; `writeCallLog` below only skips the increment if this is genuinely absent.
     */
    @Optional() private readonly metrics?: MetricsRegistry,
    /**
     * T-RR-080. `@Optional()` for the identical back-compat reason as `metrics` above — every
     * pre-existing construction site that predates this task keeps compiling, and `performCall`
     * treats an absent resolver exactly like "resolved to REST" (no behavior change for any
     * caller that doesn't also wire this in). Every real, Nest-DI-resolved construction path
     * (`PromoCodeServiceConnectorModule`, updated by this task) always supplies a real instance.
     */
    @Optional() private readonly channelResolver?: PromoCodeChannelResolverService,
    /** T-RR-080. See `channelResolver` above — the two are always wired together in the real DI
     * graph; either alone with the other absent still degrades safely to REST-only (`performCall`
     * only ever attempts gRPC when both `channelResolver` resolved a GRPC primary *and*
     * `grpcClient` is present). */
    @Optional() private readonly grpcClient?: PromoCodeServiceGrpcClient,
    /**
     * T-RR-081. Same `@Optional()` back-compat pattern as `grpcClient` — `performCall` only ever
     * attempts Kafka when `channelResolver` resolved a `KAFKA` primary *and* this is present;
     * every real, Nest-DI-resolved construction path (`PromoCodeServiceConnectorModule`) always
     * supplies a real instance.
     */
    @Optional() private readonly kafkaClient?: PromoCodeServiceKafkaClient,
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

    let authToken: string;
    try {
      authToken = resolveAuthSecretValue(connectorConfig.auth_secret_ref);
    } catch (error) {
      const result: RedemptionResult = {
        outcome: 'PERMANENT_FAILURE',
        errorCode: 'MISSING_AUTH_SECRET',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      await this.writeCallLog(
        entry,
        connectorConfig,
        attemptNumber,
        // No request was ever built (failed before that point) — the summary only names the
        // config problem, never a secret value (R9).
        { authSecretRef: connectorConfig.auth_secret_ref },
        null,
        result,
        Date.now() - startedAt,
      );
      return result;
    }

    // R8: decrypted only for the duration of building/sending this one request; never logged,
    // never persisted, never cached.
    const decryptedCustomerId = this.encryption.decrypt(entry.customer_id_encrypted);
    const requestBody = buildRequestBody(entry, decryptedCustomerId);
    const requestSummary = buildRequestSummary(requestBody, entry.customer_id_hash);

    // T-RR-080: `null` (no resolver wired, or resolution itself failed) is treated by
    // `performCall` exactly like "resolved to REST" — this task's own back-compat guarantee.
    const resolved = await this.resolveChannel(entry);
    const outcome = await this.performCall(connectorConfig, authToken, requestBody, resolved);

    const latencyMs = Date.now() - startedAt;
    await this.writeCallLog(
      entry,
      connectorConfig,
      attemptNumber,
      requestSummary,
      outcome.responseSummary,
      outcome.result,
      latencyMs,
    );
    return outcome.result;
  }

  /**
   * Makes the actual HTTP call and reduces it to one of `RedemptionResult`'s three outcomes, per
   * `08-EXTERNAL-INTEGRATION-CONTRACTS.md` §2's mechanical mapping:
   *  - no response at all (network error, DNS failure, timeout) -> `RETRYABLE_FAILURE`.
   *  - HTTP `401` -> `PERMANENT_FAILURE` (implementation note 4's own deliberate deviation: a
   *    misconfigured `auth_secret_ref` will not resolve itself on a bare retry).
   *  - HTTP `5xx` -> `RETRYABLE_FAILURE` (transport-level).
   *  - any other non-`200` (e.g. `400`) -> `PERMANENT_FAILURE` (a malformed request this
   *    connector itself built will not become well-formed on a bare retry either).
   *  - HTTP `200`, `status: 'SUCCESS'` -> `SUCCESS`, `externalReferenceId = promoCodeId`.
   *  - HTTP `200`, `status: 'FAILED'` -> `RETRYABLE_FAILURE` if `errorCode` is a member of
   *    `connectorConfig.retryable_error_codes`, else `PERMANENT_FAILURE` — list membership only,
   *    never a hardcoded per-code branch (R7).
   */
  private async callAndClassify(
    connectorConfig: ExternalRewardSystemConfig,
    authToken: string,
    requestBody: PromoCodeGenerateRequest,
  ): Promise<CallOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROMO_CODE_SERVICE_CALL_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(connectorConfig.endpoint_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.warn(
        `PromoCodeServiceConnector transport failure: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        result: {
          outcome: 'RETRYABLE_FAILURE',
          errorCode: null,
          errorMessage: `Transport failure calling promo-code-service: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        responseSummary: null,
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      return {
        result: {
          outcome: 'PERMANENT_FAILURE',
          errorCode: 'HTTP_401',
          // Implementation note 4: a 401 (misconfigured auth_secret_ref) is not going to resolve
          // itself on a bare retry — deliberate deviation from "any transport failure is
          // generally retryable".
          errorMessage: 'promo-code-service rejected the call with HTTP 401 (not retryable)',
        },
        responseSummary: null,
      };
    }

    if (response.status >= 500) {
      return {
        result: {
          outcome: 'RETRYABLE_FAILURE',
          errorCode: `HTTP_${response.status}`,
          errorMessage: `promo-code-service returned HTTP ${response.status}`,
        },
        responseSummary: null,
      };
    }

    if (response.status !== 200) {
      return {
        result: {
          outcome: 'PERMANENT_FAILURE',
          errorCode: `HTTP_${response.status}`,
          errorMessage: `promo-code-service returned unexpected HTTP ${response.status}`,
        },
        responseSummary: null,
      };
    }

    const body = (await response.json().catch(() => null)) as PromoCodeGenerateResponse | null;
    return classifyGenerateResponseBody(body, connectorConfig);
  }

  /**
   * T-RR-080. Resolves this entry's REST-vs-gRPC channel via `PromoCodeChannelResolverService`
   * (migration `018`'s own precedence table) — `null` (no resolver wired at all, or the resolver
   * itself threw, e.g. `PromoCodeChannelResolutionError` because even the seeded `GLOBAL` row is
   * unreachable) is treated by `performCall` exactly like "resolved to REST": a channel-config
   * problem must never block a redemption this connector could otherwise complete over the
   * always-available REST path.
   */
  private async resolveChannel(
    entry: ClaimedRewardEntry,
  ): Promise<ResolvedPromoCodeChannel | null> {
    if (!this.channelResolver) {
      return null;
    }
    try {
      return await this.channelResolver.resolve({
        rewardCode: entry.reward_code,
        trackerCode: entry.tracker_code,
        campaignCode: entry.campaign_code,
        tenantId: entry.tenant_id,
      });
    } catch (error) {
      this.logger.warn(
        `PromoCodeChannelResolverService.resolve failed for reward_entry ${entry.id}, ` +
          `defaulting to REST: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * T-RR-080/T-RR-081. The tier-selection algorithm this task's own implementation note 4 asks
   * for, mirroring `OutboxPublisherService.attemptChannel()`'s broker-unreachable-vs-per-message
   * distinction for the outbound leg, applied here to a *synchronous* call this redemption's own
   * outcome blocks on:
   *
   *  1. `resolved` is `null`, `primaryChannel === 'REST'`, `primaryChannel === 'GRPC'` but
   *     `grpcEnabled === false`, or `primaryChannel === 'KAFKA'` but `kafkaEnabled === false`
   *     (TC-3/TC-4 of the two tasks, both misconfigured cases) — all reduce to "attempt REST", the
   *     exact pre-T-RR-080 behavior (TC-1).
   *  2. `primaryChannel === 'KAFKA'` and enabled (T-RR-081 TC-5) — attempt Kafka. A *completed*
   *     round trip (`SUCCESS`/classified business `FAILED`, TC-1) **or** a reply timeout (TC-2,
   *     already reduced to `RETRYABLE_FAILURE` by `callAndClassifyKafka`) is returned as-is,
   *     never falls back — T-RR-081 implementation note 3: a timeout means the request may still
   *     be processing on promo-code-service's own side, so this connector must never race a second
   *     request against it over another transport. Only a *publish*-level transport failure (the
   *     request was never sent at all) triggers an immediate, same-call fallback to REST.
   *  3. Otherwise (`primaryChannel === 'GRPC'` and enabled, TC-2 of T-RR-080) — attempt gRPC. A
   *     *completed* response (`SUCCESS` or a classified business `FAILED`, TC-5) is returned as-is,
   *     never falls back: only a transport-level failure (no client certificate, connection
   *     refused, deadline exceeded) triggers an immediate, same-call fallback to REST (TC-4) —
   *     there is no "row" here to retry across cycles, so "fallback" means "try REST right now," not
   *     "wait for a later poll" (T-RR-080 implementation note 4).
   *
   * Deliberately hardcodes the fallback target to REST rather than reading
   * `resolved.fallbackChannel` generically: REST, gRPC and Kafka are the only three channels this
   * plan implements, and neither gRPC nor Kafka has a further fallback target of its own once its
   * own transport has already failed — a future task adding a fourth channel is the right place to
   * generalize this, not a speculative abstraction here for a case that cannot yet occur.
   */
  private async performCall(
    connectorConfig: ExternalRewardSystemConfig,
    authToken: string,
    requestBody: PromoCodeGenerateRequest,
    resolved: ResolvedPromoCodeChannel | null,
  ): Promise<CallOutcome> {
    const useKafkaPrimary =
      resolved !== null && resolved.primaryChannel === 'KAFKA' && resolved.kafkaEnabled;
    const useGrpcPrimary =
      resolved !== null && resolved.primaryChannel === 'GRPC' && resolved.grpcEnabled;

    if (useKafkaPrimary) {
      const kafkaOutcome = await this.callAndClassifyKafka(connectorConfig, requestBody);
      if (!kafkaOutcome.transportFailure) {
        return kafkaOutcome.outcome;
      }
      this.logger.warn(
        'PromoCodeServiceConnector Kafka publish failure — falling back to REST within the same ' +
          'redeem() call',
      );
      return this.callAndClassify(connectorConfig, authToken, requestBody);
    }

    if (!useGrpcPrimary) {
      return this.callAndClassify(connectorConfig, authToken, requestBody);
    }

    const grpcOutcome = await this.callAndClassifyGrpc(connectorConfig, requestBody);
    if (!grpcOutcome.transportFailure) {
      return grpcOutcome.outcome;
    }

    this.logger.warn(
      'PromoCodeServiceConnector gRPC transport failure — falling back to REST within the same ' +
        'redeem() call',
    );
    return this.callAndClassify(connectorConfig, authToken, requestBody);
  }

  /**
   * T-RR-081. Makes the actual Kafka request/reply round trip
   * (`PromoCodeServiceKafkaClient.requestAndAwaitReply`) and reduces it the identical way
   * `callAndClassify`/`callAndClassifyGrpc` reduce their own transport's response —
   * `classifyGenerateResponseBody` (via `normalizeKafkaResultData`) is the one shared
   * classification path, so a completed round trip maps to exactly the same `RedemptionResult`
   * regardless of which transport produced it.
   *
   * `transportFailure: true` is returned **only** for a *publish*-level failure (the request was
   * never sent) — a reply timeout is a *completed* attempt from this connector's own point of view
   * (implementation note 3) and is returned as a classified `RETRYABLE_FAILURE`, `transportFailure:
   * false`, specifically so `performCall` never races a second request over REST/gRPC while the
   * first may still be in flight on promo-code-service's own side.
   */
  private async callAndClassifyKafka(
    connectorConfig: ExternalRewardSystemConfig,
    requestBody: PromoCodeGenerateRequest,
  ): Promise<{ outcome: CallOutcome; transportFailure: boolean }> {
    if (!this.kafkaClient) {
      // Defensive only — `performCall` only reaches here when `channelResolver` resolved a real
      // `KAFKA` primary, and the real DI graph always wires `kafkaClient` alongside
      // `channelResolver` (`PromoCodeServiceConnectorModule`). Treated as a transport failure so
      // the caller still falls back to REST rather than throwing.
      return {
        transportFailure: true,
        outcome: {
          result: {
            outcome: 'RETRYABLE_FAILURE',
            errorCode: null,
            errorMessage: 'PromoCodeServiceKafkaClient not configured',
          },
          responseSummary: null,
        },
      };
    }

    let resultData: PromoCodeGenerateResultData;
    try {
      resultData = await this.kafkaClient.requestAndAwaitReply(
        requestBody.correlationId,
        requestBody.tenantId,
        toKafkaRequestData(requestBody),
      );
    } catch (error) {
      if (error instanceof PromoCodeKafkaReplyTimeoutError) {
        return {
          transportFailure: false,
          outcome: {
            result: {
              outcome: 'RETRYABLE_FAILURE',
              errorCode: 'KAFKA_REPLY_TIMEOUT',
              errorMessage: error.message,
            },
            responseSummary: null,
          },
        };
      }
      this.logger.warn(
        `PromoCodeServiceConnector Kafka transport failure: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        transportFailure: true,
        outcome: {
          result: {
            outcome: 'RETRYABLE_FAILURE',
            errorCode: null,
            errorMessage: `Transport failure calling promo-code-service over Kafka: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          responseSummary: null,
        },
      };
    }

    return {
      transportFailure: false,
      outcome: classifyGenerateResponseBody(normalizeKafkaResultData(resultData), connectorConfig),
    };
  }

  /**
   * T-RR-080. Makes the actual gRPC call (`PromoCodeServiceGrpcClient.generateCode`) and reduces
   * it the identical way `callAndClassify` reduces the REST response — `classifyGenerateResponseBody`
   * is the one shared classification path so a completed response (`SUCCESS`/`FAILED`) maps to
   * exactly the same `RedemptionResult` regardless of which transport produced it (TC-5 requires
   * this to be "identical mapping to the REST connector's own test for the same error code").
   * `transportFailure: true` is what tells `performCall` to attempt REST within this same call
   * (TC-4) — never returned for a completed response, however it classifies.
   */
  private async callAndClassifyGrpc(
    connectorConfig: ExternalRewardSystemConfig,
    requestBody: PromoCodeGenerateRequest,
  ): Promise<{ outcome: CallOutcome; transportFailure: boolean }> {
    if (!this.grpcClient) {
      // Defensive only — `performCall` only reaches here when `channelResolver` resolved a real
      // `GRPC` primary, and the real DI graph always wires `grpcClient` alongside `channelResolver`
      // (`PromoCodeServiceConnectorModule`). Treated as a transport failure so the caller still
      // falls back to REST rather than throwing.
      return {
        transportFailure: true,
        outcome: {
          result: {
            outcome: 'RETRYABLE_FAILURE',
            errorCode: null,
            errorMessage: 'PromoCodeServiceGrpcClient not configured',
          },
          responseSummary: null,
        },
      };
    }

    let response: PromoCodeGenerateResponse;
    try {
      response = await this.grpcClient.generateCode(requestBody);
    } catch (error) {
      this.logger.warn(
        `PromoCodeServiceConnector gRPC transport failure: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        transportFailure: true,
        outcome: {
          result: {
            outcome: 'RETRYABLE_FAILURE',
            errorCode: null,
            errorMessage: `Transport failure calling promo-code-service over gRPC: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          responseSummary: null,
        },
      };
    }

    return {
      transportFailure: false,
      outcome: classifyGenerateResponseBody(response, connectorConfig),
    };
  }

  /**
   * `01-DATABASE.md` §9. Written by this connector itself for every attempt (implementation
   * note 5), regardless of outcome — see this file's own header for the known double-write risk
   * on the `SUCCESS` path once wired to `RedemptionProcessingOrchestrator`/
   * `RedemptionStateMachineService`.
   */
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
      // outcome — the redemption result this method returns is what the pipeline transitions on;
      // a lost audit-log row is logged and swallowed, not propagated.
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
