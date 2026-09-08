/**
 * T-RR-035, corrected by T-INT-002. Tier 2 (REST fallback) of this service's outbound dispatch to
 * reward-tracking-service (`ARCHITECTURE.md` §9) — the "practical default" transport once this
 * service is deployed to Render (no managed Kafka broker there, that section's own framing).
 *
 * **T-INT-002 correction**: T-RR-035 posted to `/api/v1/redemptions/completed`, its own pre-RTS
 * guess at `04-REST-CONTRACT.md` §3's path, written before reward-tracking-service (RTS) existed.
 * RTS has since shipped its real controller —
 * `reward-tracking-service/src/modules/ingestion/reward-tracking-ingest.controller.ts` — serving
 * `POST /internal/reward-tracking-events`, guarded by a bearer token read from
 * `REWARD_TRACKING_INGEST_TOKEN` on RTS's own side (this client's own `REWARD_TRACKING_REST_TOKEN`
 * env var still names the value RR sends — the two services' env var *names* differ, same as every
 * other two-sided secret pair in this system; RR and RTS still need the identical secret *value*
 * configured operationally on both sides). RTS's real response body is `{"status": "applied" |
 * "duplicate"}` (`reward-tracking-ingest.controller.ts`'s own `RewardTrackingIngestResponseDto`) —
 * never `{"status": "accepted"}`, T-RR-035's own pre-RTS guess. Confirmed by direct read that RTS's
 * request-body field set (`reward-tracking-ingest.dto.ts`'s own `parseRewardTrackingIngestRequest`)
 * is otherwise compatible with the body this client already sends
 * (`toRewardTrackingMessage`/`RewardTrackingDispatchPayload`) — every field RTS requires is present
 * under the same camelCase name; RTS's own `unitType`/`unitCode` fields are optional and this
 * client sends neither, which RTS accepts as "absent" the same way it does for any other omitted
 * optional field.
 *
 * No business logic lives here (R10) — `OutboxPublisherService`/`RewardTrackingDispatchRetryWorker`
 * own every retry/backoff/tier-fallthrough decision; this class only knows how to make one HTTP
 * call and throw on failure, the same isolation `RewardTrackingKafkaProducerClient` (T-RR-034)
 * establishes for its own sibling transport.
 *
 * **`REWARD_TRACKING_REST_BASE_URL`/`REWARD_TRACKING_REST_TIMEOUT_MS`** are not named by any
 * design doc — introduced here following this project's existing
 * `<PREFIX>_GRPC_HOST`/`_PORT`/`_TIMEOUT_MS` naming shape (`PORTAL_GRPC_*`, RAP's own
 * `REWARD_REDEMPTION_GRPC_*`) collapsed to a single `_BASE_URL` since this is a REST call, not
 * gRPC — flagged in this task's own completion report as an assumption for the architect to
 * confirm/rename if a different convention is preferred later.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';

export const REWARD_TRACKING_COMPLETED_PATH = '/internal/reward-tracking-events';
export const DEFAULT_REWARD_TRACKING_REST_BASE_URL = 'http://localhost:4040';
export const DEFAULT_REWARD_TRACKING_REST_TIMEOUT_MS = 5_000;

export class MissingRewardTrackingRestTokenError extends Error {
  constructor() {
    super(
      'Missing required environment variable REWARD_TRACKING_REST_TOKEN — set it in ' +
        '.env.development (see .env.example) before RewardTrackingRestClient can call ' +
        'reward-tracking-service.',
    );
    this.name = 'MissingRewardTrackingRestTokenError';
  }
}

/**
 * R9/implementation note 2: read directly from `process.env`, same "bearer tokens are not part
 * of the bootstrap `config.schema.ts`" convention `cache-admin-token.ts` (T-RR-007) already
 * established — this service's fourth, distinct secret (`04-REST-CONTRACT.md` §3), never equal to
 * or derived from `REWARD_ENTRY_INGEST_TOKEN`/`CACHE_ADMIN_TOKEN`/`GENERATION_SERVICE_TOKEN`
 * (TC-12).
 */
export function loadRewardTrackingRestToken(): string {
  const token = process.env.REWARD_TRACKING_REST_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new MissingRewardTrackingRestTokenError();
  }
  return token;
}

export interface RewardTrackingRestClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

function parsePositiveInt(raw: string | undefined, envVarName: string, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${envVarName}: "${raw}" is not a positive integer`);
  }
  return parsed;
}

export function loadRewardTrackingRestClientOptions(): RewardTrackingRestClientOptions {
  const baseUrl =
    process.env.REWARD_TRACKING_REST_BASE_URL?.trim() || DEFAULT_REWARD_TRACKING_REST_BASE_URL;
  const timeoutMs = parsePositiveInt(
    process.env.REWARD_TRACKING_REST_TIMEOUT_MS,
    'REWARD_TRACKING_REST_TIMEOUT_MS',
    DEFAULT_REWARD_TRACKING_REST_TIMEOUT_MS,
  );
  return { baseUrl, token: loadRewardTrackingRestToken(), timeoutMs };
}

/** The one method callers actually need — narrow enough that a unit test can substitute a fake
 * instead of exercising real `fetch`/network I/O, same structural-port discipline as
 * `RewardTrackingKafkaProducerPort` (T-RR-034). `message` is the exact shared shape
 * `toRewardTrackingMessage` (`reward-tracking-outbox.repository.ts`) already builds for the Kafka
 * leg — the caller has already decrypted `customerId` onto it (R8) before this method ever sees
 * it. */
export interface RewardTrackingRestClientPort {
  dispatch(message: Record<string, unknown>): Promise<void>;
}

interface RewardTrackingRestResponseBody {
  status?: string;
}

@Injectable()
export class RewardTrackingRestClient implements RewardTrackingRestClientPort {
  private readonly logger = new Logger(RewardTrackingRestClient.name);

  /**
   * T-RR-064. `@Optional()` on `options` is the actual fix, the identical defect class and
   * remedy T-RR-055 already applied to `CampaignConfigClient`/`CampaignConfigCache` (see that
   * file's own header for the full mechanism). `options`'s type is a plain interface — erased at
   * compile time — so TypeScript's emitted `design:paramtypes` metadata for this constructor
   * parameter is `undefined`/`Object`, which Nest's automatic constructor-injection cannot map to
   * any registered provider token. Without `@Optional()`, Nest treats "no provider found for this
   * token" as a hard failure and throws `"Nest can't resolve dependencies of the
   * RewardTrackingRestClient (?)"` at module-compile time, before this constructor body — or its
   * JS-level default parameter — ever runs at all (reproduced via
   * `test/redemption/redemption-completion-side-effects.spec.ts` and
   * `test/processing/claim-worker-module-di.e2e-spec.ts`, both of which now compile
   * `RedemptionStateMachineModule`/`ClaimWorkerRootModule` — importing `DispatchModule` — through
   * real Nest DI for the first time, per T-RR-061's own wiring change). With `@Optional()`, an
   * unresolvable constructor dependency resolves to `undefined` instead of throwing, and Nest then
   * calls this constructor with `undefined` in that argument position; the JS-level default
   * parameter still applies when the caller passes `undefined` explicitly (confirmed by T-RR-055),
   * so `loadRewardTrackingRestClientOptions()` still runs and this class still gets a real,
   * env-derived options object when constructed via real Nest DI with no matching provider. Every
   * existing unit test in `reward-tracking-rest.client.spec.ts` is unaffected: each one constructs
   * this class with `new RewardTrackingRestClient(options)`, always passing an explicit,
   * fully-formed argument, so none of them relies on — or changes behaviour around — this default
   * at all.
   */
  constructor(
    @Optional()
    private readonly options: RewardTrackingRestClientOptions = loadRewardTrackingRestClientOptions(),
  ) {}

  /**
   * TC-3/TC-4: `200 { "status": "applied" | "duplicate" }` is success (RTS's real
   * `RewardTrackingIngestController.submit()`); any non-`2xx` response, an unexpected body shape, a
   * timeout, or a connection failure throws — treated identically to a Kafka publish failure. The
   * caller decides what a failure means (attempts/backoff/tier-fallthrough), never this method
   * (R10).
   */
  async dispatch(message: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl}${REWARD_TRACKING_COMPLETED_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `reward-tracking-service REST call failed with HTTP status ${response.status}`,
        );
      }
      const body = (await response
        .json()
        .catch(() => ({}) as RewardTrackingRestResponseBody)) as RewardTrackingRestResponseBody;
      if (body.status !== 'applied' && body.status !== 'duplicate') {
        throw new Error(
          `reward-tracking-service REST call returned an unexpected body (expected ` +
            `{"status":"applied"} or {"status":"duplicate"}, got status=${JSON.stringify(body.status)})`,
        );
      }
    } catch (error) {
      // R8/R9: never log `message` (may carry a plaintext `customerId`) or `this.options.token`
      // here. The caller (`OutboxPublisherService`/`RewardTrackingDispatchRetryWorker`) logs its
      // own warning without either value.
      this.logger.warn(
        `REST dispatch to reward-tracking-service failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
