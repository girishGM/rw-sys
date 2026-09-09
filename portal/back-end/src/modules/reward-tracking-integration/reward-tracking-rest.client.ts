/**
 * T-INT-030 — the REST leg (primary) of this leg's outbound client, calling RTS's real
 * `AdminRewardsController` (`reward-tracking-service/src/modules/api/admin-rewards.controller.ts`)
 * directly, one freshly-minted bearer token per call (`RewardTrackingAdminTokenService`).
 *
 * Every failure this client can produce is normalised into one of the classes below —
 * `promo-code-service.client.ts`'s own precedent (T-166): a caller has exactly one decision to
 * make from a thrown error, and it should never have to inspect a raw `TypeError` or a parsed JSON
 * body to make it.
 *
 *  - {@link RewardTrackingUpstreamRejectionError} — RTS answered, and its answer was a rejection
 *    the caller can act on (400/401/403/404). **The status is forwarded verbatim** (TC-4: "same
 *    rejection surfaces through the portal's own proxy, not swallowed into a 500"). RTS's own
 *    `admin-rewards.controller.ts` already made the scoping decision — its own header states a
 *    concrete claim mismatch is a deliberate, explicit 403, never a silent redirect — and this
 *    client's job is to preserve that decision, not reinterpret it through the portal's own
 *    generic "404 means not-found-or-out-of-scope" convention (`common/errors/app-error.ts`).
 *  - {@link RewardTrackingServiceTimeoutError} / {@link RewardTrackingServiceUnavailableError} —
 *    RTS did not answer at all (timeout, connection refused, 5xx, an unset base URL). An operator
 *    problem, not something the caller can fix by asking again with different data.
 *  - {@link RewardTrackingGrpcNotAvailableError} — thrown by the *caller* of this client
 *    (`reward-tracking-dashboard.controller.ts`, not this file) when the resolved channel is
 *    `GRPC`. Declared here, next to the other outcomes of this leg, so every error this leg can
 *    produce lives in one place.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.schema';
import { AppError, type AppErrorOptions } from '@/common/errors/app-error';

/** Same 5s `PromoCodeServiceClient`/`FieldApiLookupHttpClient` both use for an outbound call this
 * portal blocks a request on — one number for "how long we wait on another service", not two that
 * can drift apart for no stated reason. */
export const REWARD_TRACKING_REST_TIMEOUT_MS = 5000;

export const REWARD_TRACKING_ERROR_CODE = Object.freeze({
  /** 502 — no usable answer from RTS at all. Covers "not configured" too. */
  REWARD_TRACKING_SERVICE_UNAVAILABLE: 'REWARD_TRACKING_SERVICE_UNAVAILABLE',
  /** 504 — no answer within {@link REWARD_TRACKING_REST_TIMEOUT_MS}. */
  REWARD_TRACKING_SERVICE_TIMEOUT: 'REWARD_TRACKING_SERVICE_TIMEOUT',
  /** RTS answered 400. */
  REWARD_TRACKING_BAD_REQUEST: 'REWARD_TRACKING_BAD_REQUEST',
  /** RTS answered 401 — should not happen with a correctly-configured shared secret; treated as
   * an operator misconfiguration, not a caller-fixable rejection. */
  REWARD_TRACKING_UNAUTHORIZED: 'REWARD_TRACKING_UNAUTHORIZED',
  /** RTS answered 403 — the expected shape of TC-4: a real, deliberate scope rejection. */
  REWARD_TRACKING_FORBIDDEN: 'REWARD_TRACKING_FORBIDDEN',
  /** RTS answered 404. */
  REWARD_TRACKING_NOT_FOUND: 'REWARD_TRACKING_NOT_FOUND',
  /** 501 — TC-6: the resolved channel is GRPC, and RTS has no read-facing gRPC surface today. */
  REWARD_TRACKING_GRPC_NOT_AVAILABLE: 'REWARD_TRACKING_GRPC_NOT_AVAILABLE',
});

/** 502 — TC connectivity failures. `logMessage`/`logContext` are server-log only, never
 * serialised into a response (`app-error.ts`'s own invariant) — the upstream's own error body and
 * this portal's bearer token must never end up in a client-visible response. */
export class RewardTrackingServiceUnavailableError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(REWARD_TRACKING_ERROR_CODE.REWARD_TRACKING_SERVICE_UNAVAILABLE, 502, options);
  }
}

/** 504 — the timeout half of {@link RewardTrackingServiceUnavailableError}. */
export class RewardTrackingServiceTimeoutError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(REWARD_TRACKING_ERROR_CODE.REWARD_TRACKING_SERVICE_TIMEOUT, 504, options);
  }
}

/**
 * RTS answered with a 400/401/403/404 — forwarded **verbatim** (TC-4). `status` is whatever RTS
 * actually sent; `code` is chosen from it purely so the value passes `SAFE_ERROR_CODE_PATTERN`
 * (`app-error.ts`) — it is never derived from RTS's own response body, which is logged
 * (`logContext`) but never echoed into this portal's own response.
 */
export class RewardTrackingUpstreamRejectionError extends AppError {
  readonly upstreamStatus: number;

  constructor(status: number, options: AppErrorOptions = {}) {
    super(codeForStatus(status), status, options);
    this.upstreamStatus = status;
  }
}

/**
 * TC-6 — thrown by the resolver-consuming call site (`reward-tracking-dashboard.controller.ts`)
 * when the resolved primary channel is `GRPC`. RTS's own gRPC surface is ingest-only today
 * (`RewardTrackingIngestService`, `ARCHITECTURE.md` finding 8; T-INT-030 implementation note 4),
 * so a gRPC call here would either hang against a service that will never answer, or dial a method
 * that does not exist. Failing closed, immediately, with this error is the documented alternative
 * to inventing a new RTS gRPC endpoint from this task.
 */
export class RewardTrackingGrpcNotAvailableError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(REWARD_TRACKING_ERROR_CODE.REWARD_TRACKING_GRPC_NOT_AVAILABLE, 501, options);
  }
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return REWARD_TRACKING_ERROR_CODE.REWARD_TRACKING_BAD_REQUEST;
    case 401:
      return REWARD_TRACKING_ERROR_CODE.REWARD_TRACKING_UNAUTHORIZED;
    case 403:
      return REWARD_TRACKING_ERROR_CODE.REWARD_TRACKING_FORBIDDEN;
    case 404:
      return REWARD_TRACKING_ERROR_CODE.REWARD_TRACKING_NOT_FOUND;
    default:
      return REWARD_TRACKING_ERROR_CODE.REWARD_TRACKING_SERVICE_UNAVAILABLE;
  }
}

/**
 * The response body of any RTS admin-rewards endpoint, passed through untouched. This client is a
 * thin transport adapter (matching `campaign-config-api.controller.ts`'s own "no resolution logic
 * is ported or duplicated" convention) — RTS already shaped these bodies
 * (`reward-kind-response-shaper.ts`); nothing here re-parses or re-validates their contents. T-INT-031
 * (a separate task, out of this one's scope) is where a typed front-end DTO belongs, once the UI
 * that consumes it exists.
 */
export type RewardTrackingProxyResponse = Record<string, unknown>;

@Injectable()
export class RewardTrackingRestClient {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async getCampaignSummary(
    campaignCode: string,
    token: string,
  ): Promise<RewardTrackingProxyResponse> {
    return this.get(
      `/reward-tracking/campaigns/${encodeURIComponent(campaignCode)}/summary`,
      token,
    );
  }

  async getMerchantSummary(
    merchantCode: string,
    token: string,
  ): Promise<RewardTrackingProxyResponse> {
    return this.get(
      `/reward-tracking/merchants/${encodeURIComponent(merchantCode)}/summary`,
      token,
    );
  }

  async getTenantSummary(tenantId: number, token: string): Promise<RewardTrackingProxyResponse> {
    return this.get(`/reward-tracking/tenants/${tenantId}/summary`, token);
  }

  async getCountrySummary(
    countryCode: string,
    token: string,
  ): Promise<RewardTrackingProxyResponse> {
    return this.get(`/reward-tracking/countries/${encodeURIComponent(countryCode)}/summary`, token);
  }

  /** TC-7: RTS answers `{ alerts: [] }` (never a 500) when there is nothing to report — this
   * method returns that body exactly as received, an empty array included. */
  async getAlerts(token: string): Promise<RewardTrackingProxyResponse> {
    return this.get('/reward-tracking/alerts', token);
  }

  private async get(path: string, token: string): Promise<RewardTrackingProxyResponse> {
    const url = this.buildUrl(path);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REWARD_TRACKING_REST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new RewardTrackingServiceTimeoutError({
          cause: error,
          logMessage: `reward-tracking-service REST call timed out after ${String(REWARD_TRACKING_REST_TIMEOUT_MS)}ms`,
          logContext: { url },
        });
      }
      // Connection refused, DNS failure, TLS failure, reset mid-flight — the same "cannot have
      // produced any answer" set `promo-code-service.client.ts`'s own catch documents.
      throw new RewardTrackingServiceUnavailableError({
        cause: error,
        logMessage: 'reward-tracking-service REST call failed before a response was received',
        logContext: { url },
      });
    }

    if ([400, 401, 403, 404].includes(response.status)) {
      const body = await safeReadJson(response);
      throw new RewardTrackingUpstreamRejectionError(response.status, {
        logMessage: `reward-tracking-service rejected the request with ${String(response.status)}`,
        logContext: { url, status: response.status, body },
      });
    }

    if (!response.ok) {
      // Everything else — 5xx, an unexpected 3xx, a status this leg has no specific handling
      // for. An operator's problem, surfaced as 502 with the real status kept in the log.
      throw new RewardTrackingServiceUnavailableError({
        logMessage: `reward-tracking-service REST call responded with status ${String(response.status)}`,
        logContext: { url, status: response.status },
      });
    }

    const body = await safeReadJson(response);
    if (body === undefined) {
      throw new RewardTrackingServiceUnavailableError({
        logMessage: 'reward-tracking-service returned a 2xx response with a non-JSON body',
        logContext: { url },
      });
    }
    return body as RewardTrackingProxyResponse;
  }

  /** `REWARD_TRACKING_SERVICE_BASE_URL` + `path`, with any trailing slash on the base removed —
   * same normalisation `promo-code-service.client.ts#buildBindUrl` uses. */
  private buildUrl(path: string): string {
    const baseUrl = this.config.get('REWARD_TRACKING_SERVICE_BASE_URL', { infer: true });
    if (typeof baseUrl !== 'string' || baseUrl === '') {
      throw new RewardTrackingServiceUnavailableError({
        logMessage:
          'reward-tracking-service call refused: REWARD_TRACKING_SERVICE_BASE_URL is not configured',
      });
    }
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
