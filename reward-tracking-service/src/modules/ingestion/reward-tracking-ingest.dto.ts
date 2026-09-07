/**
 * T-RTS-013. Structural (shape-only) validation for `POST /internal/reward-tracking-events`'s JSON
 * body into `ApplyRewardTrackingEventInput` (`reward-tracking-ingestion.service.ts`, T-RTS-010) —
 * field-for-field the identical set the gRPC controller's own `toApplyInput`
 * (`reward-tracking-ingest.grpc-controller.ts`, T-RTS-011) and the Kafka consumer's own
 * `parseRewardTrackingEventMessage` (`reward-tracking-event.schema.ts`, T-RTS-012) already validate,
 * so all three channels reject the identical shape of malformed event the identical way
 * (`AGENT-PROTOCOL.md` R8's "same observable outcome" — the property `T-RTS-014`'s cross-channel
 * parity tests assert). Deliberately hand-rolled rather than `zod` (unlike
 * `reward-redemption-service`'s own REST DTO precedent, confirmed by direct read) — this service's
 * own two sibling adapters in this exact wave (T-RTS-011/012) already established a hand-rolled,
 * no-new-dependency convention for this identical DTO shape; matching that, not a different sibling
 * project's own choice, is what actually gives `T-RTS-014` byte-for-byte comparable validation
 * behavior across all three of *this* service's channels.
 *
 * Throws a real NestJS `BadRequestException` (→ HTTP `400`) on any structural failure — never a
 * partially-populated `ApplyRewardTrackingEventInput` — so a malformed body never reaches
 * `RewardTrackingIngestionService.applyRewardTrackingEvent()` at all (TC-4).
 */
import { BadRequestException } from '@nestjs/common';
import type { RewardKind } from '@/database/models/reward-fact.model';
import type { ApplyRewardTrackingEventInput } from './reward-tracking-ingestion.service';

const VALID_REWARD_KINDS: ReadonlyArray<RewardKind> = [
  'FIXED_AMOUNT',
  'PERCENTAGE',
  'POINTS',
  'PHYSICAL',
  'PROMO_CODE',
];

function badRequest(message: string): never {
  throw new BadRequestException(message);
}

function requireNonEmptyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    badRequest(`${field} is required`);
  }
  return value as string;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requirePositiveIntTenantId(body: Record<string, unknown>): number {
  const value = body.tenantId;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    badRequest('tenantId is required and must be a positive integer');
  }
  return value as number;
}

function requireDecimalString(body: Record<string, unknown>, field: string): string {
  const value = requireNonEmptyString(body, field);
  if (Number.isNaN(Number.parseFloat(value)) || !Number.isFinite(Number(value))) {
    badRequest(`${field} "${value}" is not a valid decimal number`);
  }
  return value;
}

function requireDate(body: Record<string, unknown>, field: string): Date {
  const raw = requireNonEmptyString(body, field);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    badRequest(`${field} "${raw}" must be a valid timestamp`);
  }
  return parsed;
}

function optionalDate(body: Record<string, unknown>, field: string): Date | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (typeof raw !== 'string') {
    badRequest(`${field} must be a string timestamp when provided`);
  }
  const parsed = new Date(raw as string);
  if (Number.isNaN(parsed.getTime())) {
    badRequest(`${field} "${String(raw)}" must be a valid timestamp when provided`);
  }
  return parsed;
}

function optionalRewardKind(body: Record<string, unknown>): RewardKind | null {
  const value = body.rewardKind;
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !VALID_REWARD_KINDS.includes(value as RewardKind)) {
    badRequest(
      `rewardKind "${String(value)}" must be one of ${VALID_REWARD_KINDS.join(', ')} when provided`,
    );
  }
  return value as RewardKind;
}

/**
 * Parses+validates a raw `POST /internal/reward-tracking-events` JSON body into an
 * `ApplyRewardTrackingEventInput` (`receivedChannel: 'REST'`), or throws `BadRequestException`
 * (TC-4) — never returns a partial/best-effort result.
 */
export function parseRewardTrackingIngestRequest(body: unknown): ApplyRewardTrackingEventInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    badRequest('request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;

  const rewardEntryId = requireNonEmptyString(b, 'rewardEntryId');
  const correlationId = requireNonEmptyString(b, 'correlationId');
  const tenantId = requirePositiveIntTenantId(b);
  const customerId = requireNonEmptyString(b, 'customerId');
  const campaignCode = requireNonEmptyString(b, 'campaignCode');
  const trackerCode = requireNonEmptyString(b, 'trackerCode');
  const trackerComponentCode = requireNonEmptyString(b, 'trackerComponentCode');
  const rewardCode = requireNonEmptyString(b, 'rewardCode');
  const rewardCategory = requireNonEmptyString(b, 'rewardCategory');
  const rewardValue = requireDecimalString(b, 'rewardValue');
  const rewardValueUnit = requireNonEmptyString(b, 'rewardValueUnit');
  const redeemedAt = requireDate(b, 'redeemedAt');
  const expiresAt = optionalDate(b, 'expiresAt');
  const rewardKind = optionalRewardKind(b);

  return {
    rewardEntryId,
    correlationId,
    receivedChannel: 'REST',
    tenantId,
    tenantCode: optionalString(b.tenantCode),
    countryCode: optionalString(b.countryCode),
    customerId,
    campaignCode,
    trackerCode,
    trackerComponentCode,
    merchantCode: optionalString(b.merchantCode),
    rewardCode,
    rewardCategory,
    rewardKind,
    unitType: optionalString(b.unitType),
    unitCode: optionalString(b.unitCode),
    rewardValue,
    rewardValueUnit,
    externalSystemCode: optionalString(b.externalSystemCode),
    externalReferenceId: optionalString(b.externalReferenceId),
    promoCodeConfigId: optionalString(b.promoCodeConfigId),
    promoCodeConfigVersionNo: optionalNumber(b.promoCodeConfigVersionNo),
    redeemedAt,
    expiresAt,
  };
}
