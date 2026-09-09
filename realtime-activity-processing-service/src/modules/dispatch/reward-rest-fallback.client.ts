/**
 * T-INT-006. `RewardRestFallbackClient` — the new REST option for this leg's dispatch chain
 * (`ARCHITECTURE.md` finding 6(b): "no REST option ever built" — the spec itself always allowed
 * "REST or gRPC" as fallback, `ARCHITECTURE.md` §1 point 4). Posts to RR's real, stable REST
 * ingestion endpoint, `POST /api/v1/reward-entries`
 * (`reward-redemption-service/src/rest/reward-entries/reward-entries.controller.ts`, T-RR-013),
 * confirmed by direct read of that file plus its own `reward-entry-request.dto.ts`/
 * `ingest-token.guard.ts`: bearer-auth via `REWARD_ENTRY_INGEST_TOKEN` (RR's own env var name for
 * the shared secret value — this client's own `REWARD_REDEMPTION_REST_TOKEN` env var names the same
 * value on RAP's side, same "two names, one shared secret value" convention every other two-sided
 * secret pair in this system already uses, e.g. RR's own `REWARD_TRACKING_REST_TOKEN` calling RTS),
 * `200 {"rewardEntryId": string, "status": string}` on success — **never** an HTTP Conflict for a
 * duplicate `id` (`reward-entries.controller.ts`'s own header: "always 200, reporting whatever
 * status `ingest()` returns for the existing row").
 *
 * **Field-shape confirmation (this task's own implementation note 3)**: RR's REST request schema
 * (`reward-entry-request.dto.ts`'s own `requestSchema`) accepts exactly the same field *set*, same
 * camelCase names, as `RewardEntryGrpcPayload` (`reward-grpc-fallback.client.ts`, this leg's already
 * -shipped gRPC option) and `RewardEntryOutboxPayload`'s own Kafka message shape
 * (`reward-entry-outbox.repository.ts`). No new field is needed on RR's side; `reward-entries.controller.ts`
 * is therefore **not** edited by this task (see this task's own completion report, "Deviations" —
 * dropped from "Files owned" per the task file's own instruction 3: "if all three already carry the
 * same fields, RR's `reward-entries.controller.ts` needs no change at all").
 *
 * **One real, field-*encoding* mismatch this task's own live verification run caught (not just a
 * field-set diff, which is why a static read of both files' TypeScript types alone missed it)**:
 * `toRewardEntryGrpcPayload`'s three genuinely-optional fields (`transactionType`, `activityCode`,
 * `merchantCode`) use proto3's own "empty string means absent" convention (`?? ''`, matching the
 * gRPC/Kafka wire shape both other channels already send). RR's REST `requestSchema` types the same
 * three fields `z.string().min(1).nullable().optional()` — accepting a real value, `null`, or
 * "key absent" as "not provided", but rejecting `""` outright (`min(1)`). A live `curl` against a
 * running `reward-entries.controller.ts` during this task's own verification reproduced this exactly
 * (`400 Bad Request`, "transactionType: String must contain at least 1 character(s)") for a row
 * whose Kafka/gRPC encoding of the same optional-absent state is a perfectly valid, already-shipped
 * `""`. `toRewardEntryRestBody` below re-encodes those three fields' `''` sentinel back to `null`
 * for this channel only — gRPC/Kafka are untouched, since their own real servers already accept
 * `''` today (confirmed: `RewardGrpcFallbackClient`/`RewardKafkaProducerClient` predate this task and
 * are out of its own Scope "Out").
 *
 * Reuses `RewardEntryGrpcPayload`/`toRewardEntryGrpcPayload` from `reward-grpc-fallback.client.ts`
 * as this client's own request *shape* too, rather than declaring a parallel, field-identical
 * interface — both channels carry the exact same field set (confirmed above), and this service's
 * own "explicit, typed mapping, never a loose spread/cast" convention
 * (`reward-entry-request.dto.ts`'s own `toRewardEntryIngestDto` doc comment) already lives entirely
 * in `toRewardEntryGrpcPayload`; a second, parallel *field-listing* function would just be that same
 * mapping copied verbatim under a different name. `toRewardEntryRestBody` below is not that — it's a
 * small, additional re-encoding step this channel alone needs, layered on top.
 *
 * No business logic lives here (R5's spirit, R10 in RR's own `AGENT-PROTOCOL.md`, applied
 * identically here) — `OutboxPublisherService` owns every retry/backoff/tier decision; this class
 * only knows how to make one HTTP call and throw on failure, the same isolation
 * `RewardGrpcFallbackClient`/RR's own `RewardTrackingRestClient` (T-RR-035/T-INT-002, ported in
 * *shape* here) already establish for their own sibling transports.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { RewardEntryGrpcPayload } from './reward-grpc-fallback.client';

export const REWARD_ENTRIES_INGEST_PATH = '/api/v1/reward-entries';
export const DEFAULT_REWARD_REDEMPTION_REST_BASE_URL = 'http://localhost:3030';
export const DEFAULT_REWARD_REDEMPTION_REST_TIMEOUT_MS = 5_000;

export class MissingRewardRedemptionRestTokenError extends Error {
  constructor() {
    super(
      'Missing required environment variable REWARD_REDEMPTION_REST_TOKEN — set it in ' +
        '.env.development (see .env.example) before RewardRestFallbackClient can call ' +
        "reward-redemption-service's REST ingestion endpoint. Must match reward-redemption-" +
        "service's own REWARD_ENTRY_INGEST_TOKEN value (operational provisioning, not a default " +
        'this codebase can safely ship).',
    );
    this.name = 'MissingRewardRedemptionRestTokenError';
  }
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

export function loadRewardRedemptionRestToken(): string {
  const token = process.env.REWARD_REDEMPTION_REST_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new MissingRewardRedemptionRestTokenError();
  }
  return token;
}

export interface RewardRestFallbackClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export function loadRewardRestFallbackClientOptions(): RewardRestFallbackClientOptions {
  const baseUrl =
    process.env.REWARD_REDEMPTION_REST_BASE_URL?.trim() || DEFAULT_REWARD_REDEMPTION_REST_BASE_URL;
  const timeoutMs = parsePositiveInt(
    process.env.REWARD_REDEMPTION_REST_TIMEOUT_MS,
    'REWARD_REDEMPTION_REST_TIMEOUT_MS',
    DEFAULT_REWARD_REDEMPTION_REST_TIMEOUT_MS,
  );
  return { baseUrl, token: loadRewardRedemptionRestToken(), timeoutMs };
}

export interface SubmitRewardEntryRestAck {
  rewardEntryId: string;
  status: string;
}

interface RewardEntryRestResponseBody {
  rewardEntryId?: string;
  status?: string;
}

/** RR's REST JSON body shape — identical to `RewardEntryGrpcPayload` except the three genuinely
 * -optional fields carry `null` instead of `''` when absent (this file's own header, "one real,
 * field-*encoding* mismatch"). A dedicated type (not a `Partial<>`/loose cast) so a future field
 * added to either shape without updating `toRewardEntryRestBody` is a compile error here too, same
 * "explicit, typed mapping" discipline `toRewardEntryGrpcPayload` already applies. */
type RewardEntryRestRequestBody = Omit<
  RewardEntryGrpcPayload,
  'transactionType' | 'activityCode' | 'merchantCode'
> & {
  transactionType: string | null;
  activityCode: string | null;
  merchantCode: string | null;
};

/** `''` -> `null` for the three fields RR's own `requestSchema` requires `null`/absent (never `''`)
 * for — every other field passes through unchanged. */
function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

function toRewardEntryRestBody(payload: RewardEntryGrpcPayload): RewardEntryRestRequestBody {
  return {
    ...payload,
    transactionType: emptyToNull(payload.transactionType),
    activityCode: emptyToNull(payload.activityCode),
    merchantCode: emptyToNull(payload.merchantCode),
  };
}

/** The one method callers actually need — narrow enough that `OutboxPublisherService`'s own tests
 * substitute a fake instead of exercising real `fetch`/network I/O, same structural-port discipline
 * `RewardTrackingRestClientPort` (RR, T-RR-034) already established. */
export interface RewardRestFallbackClientPort {
  submitRewardEntry(payload: RewardEntryGrpcPayload): Promise<SubmitRewardEntryRestAck>;
}

@Injectable()
export class RewardRestFallbackClient implements RewardRestFallbackClientPort {
  private readonly logger = new Logger(RewardRestFallbackClient.name);

  /** `@Optional()` — same fix, same reasoning, as `RewardTrackingRestClient`/`PortalConfigRestClient`
   * (T-RR-064/T-INT-011): `options`'s type is a plain interface, erased at compile time, so real
   * Nest DI with no bound provider for this exact token resolves the parameter to `undefined`
   * rather than throwing, and the JS-level default then runs `loadRewardRestFallbackClientOptions()`
   * for real. Every unit test in `reward-rest-fallback.client.spec.ts` constructs this class with an
   * explicit, fully-formed options object, so none of them relies on this default. */
  constructor(
    @Optional()
    private readonly options: RewardRestFallbackClientOptions = loadRewardRestFallbackClientOptions(),
  ) {}

  /**
   * TC-3/TC-4: `200 {"rewardEntryId": ..., "status": ...}` (RR's real
   * `RewardEntriesController.submit()`) is success, for a fresh row and a duplicate `id` alike (RR
   * never answers this endpoint with an HTTP Conflict for a duplicate). Any non-`2xx` response, an
   * unexpected/empty body, a timeout, or a connection failure throws — the caller
   * (`OutboxPublisherService`) decides what a failure means (attempts/backoff/tier-fallthrough),
   * never this method (R10).
   */
  async submitRewardEntry(payload: RewardEntryGrpcPayload): Promise<SubmitRewardEntryRestAck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl}${REWARD_ENTRIES_INGEST_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(toRewardEntryRestBody(payload)),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `reward-redemption-service REST call to ${REWARD_ENTRIES_INGEST_PATH} failed with HTTP ` +
            `status ${response.status}`,
        );
      }
      const body = (await response
        .json()
        .catch(() => ({}) as RewardEntryRestResponseBody)) as RewardEntryRestResponseBody;
      if (!body.rewardEntryId || !body.status) {
        throw new Error(
          'reward-redemption-service REST call returned an unexpected body (expected ' +
            `{"rewardEntryId": string, "status": string}, got ${JSON.stringify(body)})`,
        );
      }
      return { rewardEntryId: body.rewardEntryId, status: body.status };
    } catch (error) {
      // R4-equivalent: never log `payload` (carries a plaintext `customerId`) or `this.options.token`
      // here. The caller logs its own warning without either value.
      this.logger.warn(
        `REST dispatch to reward-redemption-service failed for reward_entry "${payload.id}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
