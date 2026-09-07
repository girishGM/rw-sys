/**
 * T-RR-012. Validates a raw `reward.entry.created.v1` Kafka message body (already `JSON.parse`d)
 * against `02-KAFKA-CONTRACTS.md` §1's own field list **before**
 * `RewardIngestionService.ingest()` (T-RR-010) is ever called (implementation note 3) — a message
 * failing this check never reaches the domain method, and is retried a bounded number of times by
 * `reward-entry-created.consumer.ts` before becoming a `reward.entry.created.dlq.v1` candidate,
 * never an ingestion-time outcome. A duplicate `id` is never a concern of this file at all — that
 * is `RewardIngestionService`'s own unique-constraint dedup (R6), entirely downstream of a
 * *successful* validation here.
 *
 * Reuses `isValidDecimalString`/`parseIsoDateWithOffset` from `src/grpc/reward-ingest.validation.ts`
 * (T-RR-011, same file-scope owner, `agent-rr-ingestion`) rather than reimplementing either check
 * against this transport's own, differently-shaped wire payload — the exact reuse that file's own
 * header anticipates, and the identical precedent RAP's own
 * `activity-ingest-schema.validator.ts` (T-RAP-023) already set for the sibling project (confirmed
 * by direct read).
 *
 * **Payload is camelCase JSON, mapped straight onto `RewardEntryIngestDto`'s own camelCase fields**
 * (`02-KAFKA-CONTRACTS.md` §1's own JSON example) — no snake_case translation happens here; that
 * translation is `RewardRedemptionEntryRepository`'s own job, one layer downstream.
 * **`country`/`tenantCode`/`rewardProcessedEnv` are never expected on this wire**
 * (`ARCHITECTURE.md` §6's reconciliation table, implementation note 6) — this validator does not
 * look for them, and their absence is never a validation failure.
 */
import { isValidDecimalString, parseIsoDateWithOffset } from '@/grpc/reward-ingest.validation';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';

export type SchemaValidationResult =
  { ok: true; dto: RewardEntryIngestDto } | { ok: false; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** `null`, `undefined`, or an empty string all mean "not provided" on this wire — the JSON example
 * (`02-KAFKA-CONTRACTS.md` §1) shows the field present with an explicit `null` value rather than
 * omitted, so both shapes must be accepted identically. */
function optionalString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

/**
 * Parses+validates a raw `reward.entry.created.v1` message body into a `RewardEntryIngestDto`
 * (`ingestionChannel: 'KAFKA'`), or a human-readable failure reason otherwise. Never throws.
 */
export function validateRewardEntryCreatedMessage(payload: unknown): SchemaValidationResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'message body is not a JSON object' };
  }
  const body = payload as Record<string, unknown>;

  const id = body.id;
  if (!isNonEmptyString(id)) {
    return { ok: false, reason: 'id is required' };
  }

  const correlationId = body.correlationId;
  if (!isNonEmptyString(correlationId)) {
    return { ok: false, reason: 'correlationId is required' };
  }

  const tenantId = body.tenantId;
  if (typeof tenantId !== 'number' || !Number.isFinite(tenantId)) {
    return { ok: false, reason: 'tenantId is required and must be a finite number' };
  }

  const customerId = body.customerId;
  if (!isNonEmptyString(customerId)) {
    return { ok: false, reason: 'customerId is required' };
  }

  const customerIdType = body.customerIdType;
  if (!isNonEmptyString(customerIdType)) {
    return { ok: false, reason: 'customerIdType is required' };
  }

  const rawActivityPerformedDate = body.activityPerformedDate;
  if (!isNonEmptyString(rawActivityPerformedDate)) {
    return { ok: false, reason: 'activityPerformedDate is required' };
  }
  const activityPerformedDate = parseIsoDateWithOffset(rawActivityPerformedDate);
  if (activityPerformedDate === null) {
    return {
      ok: false,
      reason: `activityPerformedDate "${rawActivityPerformedDate}" must be a valid ISO-8601 timestamp with an explicit UTC offset`,
    };
  }

  // One-of, per `02-KAFKA-CONTRACTS.md` §1's own JSON example / RAP's proto comment — either may
  // be `null` but not both.
  const transactionType = optionalString(body.transactionType);
  const activityCode = optionalString(body.activityCode);
  if (transactionType === null && activityCode === null) {
    return { ok: false, reason: 'one of transactionType or activityCode is required' };
  }

  const activityType = body.activityType;
  if (!isNonEmptyString(activityType)) {
    return { ok: false, reason: 'activityType is required' };
  }

  const activityCategory = body.activityCategory;
  if (!isNonEmptyString(activityCategory)) {
    return { ok: false, reason: 'activityCategory is required' };
  }

  const activityValue = body.activityValue;
  if (!isNonEmptyString(activityValue) || !isValidDecimalString(activityValue)) {
    return {
      ok: false,
      reason: `activityValue "${String(activityValue)}" is not a valid decimal number`,
    };
  }

  const activityValueUnit = body.activityValueUnit;
  if (!isNonEmptyString(activityValueUnit)) {
    return { ok: false, reason: 'activityValueUnit is required' };
  }

  const channel = body.channel;
  if (!isNonEmptyString(channel)) {
    return { ok: false, reason: 'channel is required' };
  }

  const activityPerformedEnv = body.activityPerformedEnv;
  if (!isNonEmptyString(activityPerformedEnv)) {
    return { ok: false, reason: 'activityPerformedEnv is required' };
  }

  const activityName = body.activityName;
  if (!isNonEmptyString(activityName)) {
    return { ok: false, reason: 'activityName is required' };
  }

  const campaignCode = body.campaignCode;
  if (!isNonEmptyString(campaignCode)) {
    return { ok: false, reason: 'campaignCode is required' };
  }

  const trackerCode = body.trackerCode;
  if (!isNonEmptyString(trackerCode)) {
    return { ok: false, reason: 'trackerCode is required' };
  }

  const trackerComponentCode = body.trackerComponentCode;
  if (!isNonEmptyString(trackerComponentCode)) {
    return { ok: false, reason: 'trackerComponentCode is required' };
  }

  // Documented optional (`01-DATABASE.md` §1) — `null`/absent is well-formed, never a failure.
  const merchantCode = optionalString(body.merchantCode);

  const rewardCode = body.rewardCode;
  if (!isNonEmptyString(rewardCode)) {
    return { ok: false, reason: 'rewardCode is required' };
  }

  const rewardCategory = body.rewardCategory;
  if (!isNonEmptyString(rewardCategory)) {
    return { ok: false, reason: 'rewardCategory is required' };
  }

  const rewardValue = body.rewardValue;
  if (!isNonEmptyString(rewardValue) || !isValidDecimalString(rewardValue)) {
    return {
      ok: false,
      reason: `rewardValue "${String(rewardValue)}" is not a valid decimal number`,
    };
  }

  const rewardValueUnit = body.rewardValueUnit;
  if (!isNonEmptyString(rewardValueUnit)) {
    return { ok: false, reason: 'rewardValueUnit is required' };
  }

  const rawRewardEntryDate = body.rewardEntryDate;
  if (!isNonEmptyString(rawRewardEntryDate)) {
    return { ok: false, reason: 'rewardEntryDate is required' };
  }
  const rewardEntryDate = parseIsoDateWithOffset(rawRewardEntryDate);
  if (rewardEntryDate === null) {
    return {
      ok: false,
      reason: `rewardEntryDate "${rawRewardEntryDate}" must be a valid ISO-8601 timestamp with an explicit UTC offset`,
    };
  }

  const completionCycle = body.completionCycle;
  if (typeof completionCycle !== 'number' || !Number.isInteger(completionCycle)) {
    return { ok: false, reason: 'completionCycle is required and must be an integer' };
  }

  return {
    ok: true,
    dto: {
      id,
      correlationId,
      tenantId,
      customerId,
      customerIdType,
      activityPerformedDate,
      transactionType,
      activityCode,
      activityType,
      activityCategory,
      activityValue,
      activityValueUnit,
      channel,
      activityPerformedEnv,
      activityName,
      campaignCode,
      trackerCode,
      trackerComponentCode,
      merchantCode,
      rewardCode,
      rewardCategory,
      rewardValue,
      rewardValueUnit,
      rewardEntryDate,
      completionCycle,
      ingestionChannel: 'KAFKA',
    },
  };
}
