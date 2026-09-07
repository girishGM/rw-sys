/**
 * T-RTS-012. Validates a raw `reward.redemption.completed.v1` Kafka message body (already
 * `JSON.parse`d) into an `ApplyRewardTrackingEventInput` (`RewardTrackingIngestionService`,
 * T-RTS-010) **before** `applyRewardTrackingEvent()` is ever called — the Kafka-transport
 * equivalent of `reward-tracking-ingest.grpc-controller.ts`'s own `toApplyInput` envelope
 * validation (T-RTS-011, same file-scope owner, `agent-rts-ingestion`), field-for-field, so the
 * three transport adapters reject the identical shape of malformed event the identical way
 * (`AGENT-PROTOCOL.md` R8's "same observable outcome", the property `T-RTS-014` cross-channel
 * parity tests will assert). Also mirrors `reward-redemption-service`'s own
 * `reward-entry-created.schema.ts` (T-RR-012, confirmed by direct read) in shape/never-throws
 * discipline — adapted here to this service's own DTO and field set rather than reused directly
 * (R0: a different project's own file scope, never imported across).
 *
 * Deliberately never throws — returns a `{ ok: false, reason }` result instead.
 * `RewardTrackingConsumerService`'s own bounded-retry-then-DLQ loop reads `reason` for its DLQ
 * payload / log line.
 *
 * **Known, already-accepted tension, not a new bug introduced by this task**
 * (`reward-tracking-ingestion.service.ts`'s own header, T-RTS-010, "Resolved documentation
 * inconsistency" note plus its `ApplyRewardTrackingEventInput` doc comment): `trackerCode`/
 * `trackerComponentCode` are required here even though the *actual*, currently-shipped
 * `reward.redemption.completed.v1` producer (`reward-redemption-service-plan/tasks/T-RR-034`,
 * pre-`T-RR-062`) does not populate either field yet — until `T-RR-062` lands on that side, every
 * real message on this topic will fail this validation and land on the DLQ. That is the
 * documented, conservative, expected behavior (reject a malformed-for-this-pipeline event rather
 * than let it reach `customer_reward_ledger`'s own `NOT NULL` columns), not something this task's
 * own file scope can or should work around.
 */
import type { RewardKind } from '@/database/models/reward-fact.model';
import type { ApplyRewardTrackingEventInput } from '@/modules/ingestion/reward-tracking-ingestion.service';

export type RewardTrackingEventSchemaResult =
  { ok: true; input: ApplyRewardTrackingEventInput } | { ok: false; reason: string };

const VALID_REWARD_KINDS: ReadonlyArray<RewardKind> = [
  'FIXED_AMOUNT',
  'PERCENTAGE',
  'POINTS',
  'PHYSICAL',
  'PROMO_CODE',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function optionalString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requireNonEmptyString(
  body: Record<string, unknown>,
  field: string,
): string | { ok: false; reason: string } {
  const value = body[field];
  if (!isNonEmptyString(value)) {
    return { ok: false, reason: `${field} is required` };
  }
  return value;
}

function isFailure(value: unknown): value is { ok: false; reason: string } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

function parseRequiredDate(
  body: Record<string, unknown>,
  field: string,
): Date | { ok: false; reason: string } {
  const raw = body[field];
  if (!isNonEmptyString(raw)) {
    return { ok: false, reason: `${field} is required` };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, reason: `${field} "${raw}" must be a valid timestamp` };
  }
  return parsed;
}

function parseOptionalDate(
  body: Record<string, unknown>,
  field: string,
): Date | null | { ok: false; reason: string } {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (typeof raw !== 'string') {
    return { ok: false, reason: `${field} must be a string timestamp when provided` };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, reason: `${field} "${raw}" must be a valid timestamp when provided` };
  }
  return parsed;
}

/**
 * Parses+validates a raw `reward.redemption.completed.v1` message body into an
 * `ApplyRewardTrackingEventInput` (`receivedChannel: 'KAFKA'`), or a human-readable failure reason
 * otherwise. Never throws — `payload` is expected to already be the result of a successful
 * `JSON.parse`; a non-object/array `payload` (e.g. the caller's own `JSON.parse` produced a bare
 * string or number) is itself a validation failure, not a caller bug.
 */
export function parseRewardTrackingEventMessage(payload: unknown): RewardTrackingEventSchemaResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'message body is not a JSON object' };
  }
  const body = payload as Record<string, unknown>;

  const rewardEntryId = requireNonEmptyString(body, 'rewardEntryId');
  if (isFailure(rewardEntryId)) return rewardEntryId;

  const correlationId = requireNonEmptyString(body, 'correlationId');
  if (isFailure(correlationId)) return correlationId;

  const tenantIdRaw = body.tenantId;
  if (typeof tenantIdRaw !== 'number' || !Number.isInteger(tenantIdRaw) || tenantIdRaw <= 0) {
    return { ok: false, reason: 'tenantId is required and must be a positive integer' };
  }
  const tenantId = tenantIdRaw;

  const customerId = requireNonEmptyString(body, 'customerId');
  if (isFailure(customerId)) return customerId;

  const campaignCode = requireNonEmptyString(body, 'campaignCode');
  if (isFailure(campaignCode)) return campaignCode;

  const trackerCode = requireNonEmptyString(body, 'trackerCode');
  if (isFailure(trackerCode)) return trackerCode;

  const trackerComponentCode = requireNonEmptyString(body, 'trackerComponentCode');
  if (isFailure(trackerComponentCode)) return trackerComponentCode;

  const rewardCode = requireNonEmptyString(body, 'rewardCode');
  if (isFailure(rewardCode)) return rewardCode;

  const rewardCategory = requireNonEmptyString(body, 'rewardCategory');
  if (isFailure(rewardCategory)) return rewardCategory;

  const rewardValue = requireNonEmptyString(body, 'rewardValue');
  if (isFailure(rewardValue)) return rewardValue;
  if (Number.isNaN(Number.parseFloat(rewardValue)) || !Number.isFinite(Number(rewardValue))) {
    return { ok: false, reason: `rewardValue "${rewardValue}" is not a valid decimal number` };
  }

  const rewardValueUnit = requireNonEmptyString(body, 'rewardValueUnit');
  if (isFailure(rewardValueUnit)) return rewardValueUnit;

  const redeemedAt = parseRequiredDate(body, 'redeemedAt');
  if (isFailure(redeemedAt)) return redeemedAt;

  const expiresAt = parseOptionalDate(body, 'expiresAt');
  if (isFailure(expiresAt)) return expiresAt;

  const rewardKindRaw = body.rewardKind;
  let rewardKind: RewardKind | null = null;
  if (rewardKindRaw !== undefined && rewardKindRaw !== null && rewardKindRaw !== '') {
    if (!VALID_REWARD_KINDS.includes(rewardKindRaw as RewardKind)) {
      return {
        ok: false,
        reason: `rewardKind "${String(rewardKindRaw)}" must be one of ${VALID_REWARD_KINDS.join(', ')} when provided`,
      };
    }
    rewardKind = rewardKindRaw as RewardKind;
  }

  return {
    ok: true,
    input: {
      rewardEntryId,
      correlationId,
      receivedChannel: 'KAFKA',
      tenantId,
      tenantCode: optionalString(body.tenantCode),
      countryCode: optionalString(body.countryCode),
      customerId,
      campaignCode,
      trackerCode,
      trackerComponentCode,
      merchantCode: optionalString(body.merchantCode),
      rewardCode,
      rewardCategory,
      rewardKind,
      unitType: optionalString(body.unitType),
      unitCode: optionalString(body.unitCode),
      rewardValue,
      rewardValueUnit,
      externalSystemCode: optionalString(body.externalSystemCode),
      externalReferenceId: optionalString(body.externalReferenceId),
      promoCodeConfigId: optionalString(body.promoCodeConfigId),
      promoCodeConfigVersionNo: optionalNumber(body.promoCodeConfigVersionNo),
      redeemedAt,
      expiresAt,
    },
  };
}
