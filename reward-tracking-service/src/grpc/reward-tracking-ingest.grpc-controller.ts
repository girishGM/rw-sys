/**
 * T-RTS-011. The gRPC transport adapter for `RewardTrackingIngestService.IngestRewardTrackingEvent`
 * (`proto/reward_tracking_ingest.proto`). Per `AGENT-PROTOCOL.md` R8 ("no business logic in a
 * transport adapter") this controller does exactly three things: validate/deserialize the wire
 * request into an `ApplyRewardTrackingEventInput`, call
 * `RewardTrackingIngestionService.applyRewardTrackingEvent()` (T-RTS-010) — the identical domain
 * method the Kafka consumer (T-RTS-012) and the REST controller (T-RTS-013) will also call — and
 * map the returned result back onto `IngestRewardTrackingEventResponse`. No mapping/idempotency/
 * persistence logic of its own lives here; that is entirely T-RTS-010's.
 *
 * No `@nestjs/microservices` here — that package is not a dependency of this service
 * (`package.json` is `agent-rts-foundation`'s exclusive file scope, R10, so a new dependency isn't
 * something this task can add), and this project already has a working precedent for a raw
 * `@grpc/grpc-js` transport without it:
 * `src/modules/campaign-cache/campaign-hierarchy.client.ts` (T-RTS-020) wraps the CLIENT side of a
 * gRPC contract the same way; `grpc-server.main.ts` (this task's own file, alongside this
 * controller) is the SERVER-side mirror of that same raw-`@grpc/grpc-js` approach.
 *
 * **This controller's own envelope validation, not T-RTS-010's** (this task's own implementation
 * note 3, mirroring `reward-redemption-service`'s own `T-RR-011` `RewardIngestController`
 * precedent, confirmed by direct read): every required field is checked here, before
 * `applyRewardTrackingEvent()` is ever called, so a malformed request never reaches — and never
 * partially executes inside — the domain service's own transaction. T-RTS-010's own
 * `assertWellFormed` still runs too (defense in depth, not a violation of R8 — it is still the ONE
 * shared validation for a request that got past this envelope check but is malformed in a way this
 * adapter doesn't itself parse, e.g. a non-numeric `reward_value`), but this controller does not
 * rely on it to produce `INVALID_ARGUMENT`; it throws that gRPC status itself, directly, so a
 * caller reliably gets a `1` `INVALID_ARGUMENT` gRPC status code rather than a generic thrown
 * `Error` translating to `UNKNOWN`.
 *
 * **TC-4 — `customerId` never appears in any log line.** This class itself never logs anything
 * (not even the malformed-request path, where the thrown message never interpolates
 * `request.customerId`) — the one log line this whole pipeline emits on a successful/duplicate
 * ingest is `RewardTrackingIngestionService`'s own (T-RTS-010's header), which logs
 * `customerIdHash`, never the raw value.
 */
import { Injectable } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import {
  RewardTrackingIngestionService,
  type ApplyRewardTrackingEventInput,
} from '@/modules/ingestion/reward-tracking-ingestion.service';
import type { RewardKind } from '@/database/models/reward-fact.model';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory, type StructuredLogger } from '@/observability/logging.module';

/**
 * Hand-written TypeScript shape for `proto/reward_tracking_ingest.proto`'s
 * `IngestRewardTrackingEventRequest`, as `@grpc/proto-loader` hands it to a handler at runtime —
 * camelCase (`keepCase: false`, `grpc-server.main.ts`'s own loader options), every field exactly as
 * the `.proto` declares it (`reward_value` stays a decimal-as-string, `tenant_id`/
 * `promo_code_config_version_no` are the only two `int32` fields). No code-generation step is
 * wired into this project — same "hand-in-sync with the `.proto` file" convention
 * `reward-redemption-service/src/grpc/reward-ingest.grpc.types.ts` already set for the sibling
 * project (T-RR-011).
 */
export interface IngestRewardTrackingEventRequestProto {
  rewardEntryId?: string;
  correlationId?: string;
  tenantId?: number;
  tenantCode?: string;
  countryCode?: string;
  customerId?: string;
  campaignCode?: string;
  trackerCode?: string;
  trackerComponentCode?: string;
  merchantCode?: string;
  rewardCode?: string;
  rewardCategory?: string;
  rewardKind?: string;
  unitType?: string;
  unitCode?: string;
  rewardValue?: string;
  rewardValueUnit?: string;
  externalSystemCode?: string;
  externalReferenceId?: string;
  promoCodeConfigId?: string;
  promoCodeConfigVersionNo?: number;
  redeemedAt?: string;
  expiresAt?: string;
}

export interface IngestRewardTrackingEventResponseProto {
  status: 'applied' | 'duplicate';
}

const VALID_REWARD_KINDS: ReadonlyArray<RewardKind> = [
  'FIXED_AMOUNT',
  'PERCENTAGE',
  'POINTS',
  'PHYSICAL',
  'PROMO_CODE',
];

/** Thrown only by this adapter's own envelope validation — kept distinct from
 * `InvalidRewardTrackingEventInputError` (T-RTS-010's own class) so `handleIngestRewardTrackingEvent`
 * below can map either one to the identical gRPC `INVALID_ARGUMENT` status without caring which
 * layer caught the problem. */
export class InvalidIngestRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIngestRequestError';
  }
}

function invalidArgument(message: string): never {
  throw new InvalidIngestRequestError(message);
}

/** T-RTS-049 — a request rejected for missing `correlation_id` itself has no real value to log; a
 * fallback keeps `StructuredLogger` (which requires a non-blank `correlationId`) from throwing a
 * second, masking error on top of the one already being reported. */
function correlationIdOrUnknown(value: string | undefined): string {
  return value !== undefined && value.length > 0 ? value : 'unknown';
}

function requireNonEmpty(value: string | undefined, fieldName: string): string {
  if (value === undefined || value.length === 0) {
    invalidArgument(`${fieldName} is required`);
  }
  return value;
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

function zeroToNull(value: number | undefined): number | null {
  return value === undefined || value === 0 ? null : value;
}

/** RFC3339/ISO-8601 parse — no explicit-UTC-offset requirement (unlike RR's own
 * `parseIsoDateWithOffset`), matching T-RTS-010's own, looser `Date` validity check
 * (`assertWellFormed`'s `Number.isNaN(input.redeemedAt.getTime())`) rather than inventing a
 * stricter rule this service's own domain layer doesn't itself enforce. */
function parseRequiredDate(value: string | undefined, fieldName: string): Date {
  const raw = requireNonEmpty(value, fieldName);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    invalidArgument(`${fieldName} "${raw}" must be a valid RFC3339 timestamp`);
  }
  return parsed;
}

function parseOptionalDate(value: string | undefined, fieldName: string): Date | null {
  if (value === undefined || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    invalidArgument(`${fieldName} "${value}" must be a valid RFC3339 timestamp when provided`);
  }
  return parsed;
}

function parseRewardKind(value: string | undefined): RewardKind | null {
  if (value === undefined || value.length === 0) {
    return null;
  }
  if (!VALID_REWARD_KINDS.includes(value as RewardKind)) {
    invalidArgument(
      `reward_kind "${value}" must be one of ${VALID_REWARD_KINDS.join(', ')} when provided`,
    );
  }
  return value as RewardKind;
}

@Injectable()
export class RewardTrackingIngestGrpcController {
  /** T-RTS-049 — replaces the plain `new Logger(...)` field this class used to hold. */
  private readonly structuredLogger: StructuredLogger;

  constructor(
    private readonly ingestionService: RewardTrackingIngestionService,
    private readonly metrics: MetricsService,
    loggers: StructuredLoggerFactory,
  ) {
    this.structuredLogger = loggers.forContext(RewardTrackingIngestGrpcController.name);
  }

  /**
   * Validates the wire request, maps it to T-RTS-010's own shared DTO, calls
   * `applyRewardTrackingEvent()`, and maps the result back onto the wire response. Throws
   * `InvalidIngestRequestError` for a malformed request (TC-3) — `handleIngestRewardTrackingEvent`
   * below is what translates that into a real gRPC `INVALID_ARGUMENT` status; this method stays
   * transport-status-agnostic so it can also be unit-tested directly without a live socket.
   */
  async ingestRewardTrackingEvent(
    request: IngestRewardTrackingEventRequestProto,
  ): Promise<IngestRewardTrackingEventResponseProto> {
    const input = this.toApplyInput(request);
    const result = await this.ingestionService.applyRewardTrackingEvent(input);
    return { status: result.status };
  }

  private toApplyInput(
    request: IngestRewardTrackingEventRequestProto,
  ): ApplyRewardTrackingEventInput {
    const rewardEntryId = requireNonEmpty(request.rewardEntryId, 'reward_entry_id');
    const correlationId = requireNonEmpty(request.correlationId, 'correlation_id');

    // proto3 `int32` has no wire-level "unset" distinct from `0`, and no real tenant is ever `0`
    // (same reasoning `reward-redemption-service`'s own `RewardEntryProto.tenantId` check applies).
    if (
      typeof request.tenantId !== 'number' ||
      !Number.isInteger(request.tenantId) ||
      request.tenantId <= 0
    ) {
      invalidArgument('tenant_id is required and must be a positive integer');
    }
    const tenantId = request.tenantId;

    const customerId = requireNonEmpty(request.customerId, 'customer_id');
    const campaignCode = requireNonEmpty(request.campaignCode, 'campaign_code');
    const trackerCode = requireNonEmpty(request.trackerCode, 'tracker_code');
    const trackerComponentCode = requireNonEmpty(
      request.trackerComponentCode,
      'tracker_component_code',
    );
    const rewardCode = requireNonEmpty(request.rewardCode, 'reward_code');
    const rewardCategory = requireNonEmpty(request.rewardCategory, 'reward_category');
    const rewardValue = requireNonEmpty(request.rewardValue, 'reward_value');
    if (Number.isNaN(Number.parseFloat(rewardValue)) || !Number.isFinite(Number(rewardValue))) {
      invalidArgument(`reward_value "${rewardValue}" is not a valid decimal number`);
    }
    // T-INT-050 — `reward_value_unit` is empty (`''`)/absent by design for a reward kind with no
    // fixed currency/point unit (`PROMO_CODE`/`POINTS`); unlike every other `requireNonEmpty` field
    // above, absent normalizes to `''` rather than rejecting the request. Same fix, same reasoning,
    // as `reward-redemption-service`'s own `reward_value_unit` field (T-INT-046), one hop upstream.
    const rewardValueUnit = request.rewardValueUnit ?? '';

    const redeemedAt = parseRequiredDate(request.redeemedAt, 'redeemed_at');
    const expiresAt = parseOptionalDate(request.expiresAt, 'expires_at');
    const rewardKind = parseRewardKind(request.rewardKind);

    return {
      rewardEntryId,
      correlationId,
      receivedChannel: 'GRPC',
      tenantId,
      tenantCode: emptyToNull(request.tenantCode),
      countryCode: emptyToNull(request.countryCode),
      customerId,
      campaignCode,
      trackerCode,
      trackerComponentCode,
      merchantCode: emptyToNull(request.merchantCode),
      rewardCode,
      rewardCategory,
      rewardKind,
      unitType: emptyToNull(request.unitType),
      unitCode: emptyToNull(request.unitCode),
      rewardValue,
      rewardValueUnit,
      externalSystemCode: emptyToNull(request.externalSystemCode),
      externalReferenceId: emptyToNull(request.externalReferenceId),
      promoCodeConfigId: emptyToNull(request.promoCodeConfigId),
      promoCodeConfigVersionNo: zeroToNull(request.promoCodeConfigVersionNo),
      redeemedAt,
      expiresAt,
    };
  }

  /**
   * The raw `@grpc/grpc-js` unary handler `grpc-server.main.ts`'s `server.addService(...)` binds
   * directly to the `IngestRewardTrackingEvent` method. Bound as an arrow-function class property
   * (not a prototype method) so it can be passed by reference into `addService`'s implementation
   * map without losing its `this` binding — same idiom used throughout this codebase's other
   * class-based callback registrations.
   *
   * **Never signal a malformed request via an in-body status string — always a thrown gRPC error**
   * (this task's own implementation note 2: "Response is 'applied' or 'duplicate' — nothing else;
   * a malformed request is a gRPC-level error, never a silently-accepted event"). Any other,
   * unexpected error (a genuine infrastructure failure inside T-RTS-010, e.g. a lost DB connection)
   * is surfaced as `INTERNAL` rather than swallowed.
   */
  handleIngestRewardTrackingEvent = (
    call: grpc.ServerUnaryCall<
      IngestRewardTrackingEventRequestProto,
      IngestRewardTrackingEventResponseProto
    >,
    callback: grpc.sendUnaryData<IngestRewardTrackingEventResponseProto>,
  ): void => {
    this.ingestRewardTrackingEvent(call.request).then(
      (response) => callback(null, response),
      (error: unknown) => {
        // T-RTS-049 item 2 — both branches below count as a failed ingestion attempt over this
        // channel; neither ever reaches `applyRewardTrackingEvent()`'s own success-path increment.
        this.metrics.incrementEventsIngested('GRPC', 'failed');
        if (error instanceof InvalidIngestRequestError) {
          this.structuredLogger.warn('reward tracking event rejected: invalid request', {
            correlationId: correlationIdOrUnknown(call.request.correlationId),
            rewardEntryId: call.request.rewardEntryId,
            error: error.message,
          });
          callback({ code: grpc.status.INVALID_ARGUMENT, message: error.message });
          return;
        }
        // Deliberately never interpolates `call.request.customerId` (TC-4) — only the error's own
        // message (never containing plaintext customerId, per this class's own header) and the
        // rewardEntryId, which is not sensitive.
        this.structuredLogger.error(
          'unexpected failure ingesting reward tracking event over gRPC',
          {
            correlationId: correlationIdOrUnknown(call.request.correlationId),
            rewardEntryId: call.request.rewardEntryId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'internal error',
        });
      },
    );
  };
}
