/**
 * T-RR-023. Two-tier retry classification (R7, `05-PROCESSING-PIPELINE.md` §5) — never
 * "retry on any failure":
 *
 * 1. **Transport-level failure** (timeout, 5xx, connection refused, DNS failure — never reached
 *    the remote system's own business logic) is *generally* retryable, but the connector that made
 *    the call (Wave 3, out of this task's scope — this service only classifies an outcome it is
 *    *given*) may set `isPermanent` to flag a specific transport failure it knows will not resolve
 *    on a bare retry (e.g. a `401` from a misconfigured `auth_secret_ref`). This override is an
 *    explicit input to `classify()`, never a hardcoded "all transport failures are retryable"
 *    assumption.
 * 2. **In-body business rejection** is retryable **only if** its `errorCode` appears in the
 *    resolved `external_reward_system_config.retryable_error_codes` list passed in as `config` —
 *    never by default, never hardcoded anywhere in this file. Which error codes are retryable is
 *    entirely a property of the `retryable_error_codes` jsonb column (data), not a branch in this
 *    service's own code — see this task's own test fixtures for the one worked example
 *    `05-PROCESSING-PIPELINE.md` §5 walks through (promo-code-service's own retry-budget-exhaustion
 *    error code); no such literal error-code string appears anywhere in this production file
 *    (TC-10).
 *
 * Backoff formula matches §5 exactly: `delayMs = min(retry_backoff_base_ms * 2 ^ (retry_count -
 * 1), retry_backoff_max_ms)`. No jitter is applied — §5 leaves jitter to "the implementation's own
 * discretion"; this implementation does not add it, keeping the delay a pure, deterministic
 * function of `retryCount`/the resolved system's own backoff config (documented here per the task
 * file's own instruction to record the decision either way).
 *
 * This service does **not** decide `retrying` vs. `failed` (comparing `retry_count` against
 * `max_retry_attempts`) — that is T-RR-024's retry-orchestration job, layered on top of the
 * `RETRYABLE_FAILURE`/`PERMANENT_FAILURE` outcome this service returns (see this task's own "Out
 * of scope" note). Nor does this service read or write anything about
 * `reward_tracking_dispatch_retry` — a completely separate retry budget (§5's own explicit
 * warning), never conflated with this one (implementation note 6).
 */
import { Injectable } from '@nestjs/common';

/** The remote system responded successfully at the transport level with a business-level
 * rejection carrying its own error code. */
export interface BusinessRejectionOutcome {
  kind: 'BUSINESS_REJECTION';
  errorCode: string;
  errorMessage?: string;
}

/** A timeout, 5xx, connection refused, DNS failure, or anything else that never reached the
 * remote system's own business logic. */
export interface TransportFailureOutcome {
  kind: 'TRANSPORT_FAILURE';
  /** The connector's own judgment call (`05-PROCESSING-PIPELINE.md` §5) that this specific
   * transport failure will not resolve on a bare retry. Omitted/`false` means "generally
   * retryable", the default for this tier. */
  isPermanent?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface SuccessOutcome {
  kind: 'SUCCESS';
}

/** The raw outcome of a connector call, classified by `classify()` — produced by a Wave 3
 * connector implementation, never by this module. */
export type ConnectorCallOutcome =
  SuccessOutcome | TransportFailureOutcome | BusinessRejectionOutcome;

/** The subset of a resolved `external_reward_system_config` row (`01-DATABASE.md` §3) this
 * service's classification needs — never the whole row, so a caller cannot accidentally pass
 * connector credentials (`endpoint_url`/`auth_secret_ref`, R9) into a code path that has no
 * business seeing them. */
export interface RetryClassificationConfig {
  retryableErrorCodes: readonly string[];
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
}

/** Discriminated union — a caller checks `.outcome` once and TypeScript narrows the rest, rather
 * than remembering to check a loosely-typed string plus separate fields together correctly (R2).
 */
export type ClassificationResult =
  | { outcome: 'SUCCESS' }
  | { outcome: 'RETRYABLE_FAILURE'; nextDelayMs: number }
  | { outcome: 'PERMANENT_FAILURE'; reason: string };

@Injectable()
export class RetryClassificationService {
  /**
   * Classifies a connector call's raw outcome into `SUCCESS | RETRYABLE_FAILURE |
   * PERMANENT_FAILURE` (R7).
   *
   * @param retryCount The retry attempt number this classification's backoff delay (if any) is
   *   being computed for — matches the row's own `retry_count` after this failure's increment
   *   (`05-PROCESSING-PIPELINE.md` §5's own formula: `retry_count = 3` means the third retry).
   */
  classify(
    outcome: ConnectorCallOutcome,
    config: RetryClassificationConfig,
    retryCount: number,
  ): ClassificationResult {
    if (outcome.kind === 'SUCCESS') {
      return { outcome: 'SUCCESS' };
    }

    if (outcome.kind === 'TRANSPORT_FAILURE') {
      if (outcome.isPermanent) {
        return {
          outcome: 'PERMANENT_FAILURE',
          reason:
            outcome.errorMessage ??
            `Transport failure (errorCode=${outcome.errorCode ?? 'unknown'}) classified permanent by connector override`,
        };
      }
      return {
        outcome: 'RETRYABLE_FAILURE',
        nextDelayMs: this.computeBackoffDelayMs(
          retryCount,
          config.retryBackoffBaseMs,
          config.retryBackoffMaxMs,
        ),
      };
    }

    // BUSINESS_REJECTION: retryable only if its errorCode is present in retryableErrorCodes data
    // (never a hardcoded branch on any specific error code value — TC-10).
    if (config.retryableErrorCodes.includes(outcome.errorCode)) {
      return {
        outcome: 'RETRYABLE_FAILURE',
        nextDelayMs: this.computeBackoffDelayMs(
          retryCount,
          config.retryBackoffBaseMs,
          config.retryBackoffMaxMs,
        ),
      };
    }
    return {
      outcome: 'PERMANENT_FAILURE',
      reason:
        outcome.errorMessage ??
        `Business error code "${outcome.errorCode}" is not in this system's retryable_error_codes list`,
    };
  }

  /**
   * `delayMs = min(retry_backoff_base_ms * 2 ^ (retry_count - 1), retry_backoff_max_ms)`
   * (`05-PROCESSING-PIPELINE.md` §5, exactly). Exposed as its own method so it can be exercised
   * directly (TC-8/TC-9) as well as through `classify()`.
   */
  computeBackoffDelayMs(
    retryCount: number,
    retryBackoffBaseMs: number,
    retryBackoffMaxMs: number,
  ): number {
    const raw = retryBackoffBaseMs * 2 ** (retryCount - 1);
    return Math.min(raw, retryBackoffMaxMs);
  }
}
