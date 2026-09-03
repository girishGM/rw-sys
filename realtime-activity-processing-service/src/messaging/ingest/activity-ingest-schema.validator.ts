/**
 * T-RAP-023. Validates a raw `activity.ingest.v1` Kafka message body (already `JSON.parse`d)
 * against the mandatory-field/well-formed-timestamp rules `02-KAFKA-CONTRACTS.md` §1/§2 require
 * **before** `ActivityIngestionService.ingest` (T-RAP-021) is ever called (task implementation
 * note 3) — a message failing this check never reaches the domain method, and is retried a
 * bounded number of times by `activity-ingest.consumer.ts` before becoming an
 * `activity.ingest.dlq.v1` candidate, never a mapping-time outcome.
 *
 * Reuses `isValidDecimalString`/`parseActivityPerformedDate` from `src/grpc/activity-ingest.
 * validation.ts` (T-RAP-022, same file-scope owner, `agent-rap-ingestion`) rather than
 * reimplementing either check against this transport's own, differently-shaped wire payload —
 * exactly the reuse that file's own header anticipates (`AGENT-PROTOCOL.md` R5's "a fix to one
 * transport's bug must be automatically a fix to the other's" spirit, applied here to shared
 * *validation* rather than the shared domain method itself).
 *
 * **`tenantId` is a mandatory field on this payload — a deliberate interpretation flagged as a
 * design-doc gap, see this task's completion report.** `SubmitActivityRequest`
 * (`activity_ingest.proto`) deliberately has no `tenant_id` field because gRPC resolves the
 * caller's tenant out of band, from mTLS client identity (`src/grpc/mtls.guard.ts`).
 * `02-KAFKA-CONTRACTS.md` §1 names only "the mandatory activity fields (`ARCHITECTURE.md`/user
 * spec)" without enumerating them, and does not document any equivalent per-message,
 * out-of-band caller-identity mechanism for the Kafka transport (no API-key-per-partition, no
 * per-topic tenant binding — nothing). Since `InboundActivity.tenantId` is required by every
 * downstream consumer of this type (T-RAP-021's fan-out insert) and there is no other source to
 * derive it from on this transport, this validator requires it directly on the wire payload as
 * the only workable interpretation — not an explicit instruction from a design doc. The architect
 * should confirm or correct this via a `02-KAFKA-CONTRACTS.md` update.
 */
import {
  isValidDecimalString,
  parseActivityPerformedDate,
} from '@/grpc/activity-ingest.validation';
import type { InboundActivity } from '@/modules/idempotency/inbound-activity.types';

export type SchemaValidationResult =
  { ok: true; activity: InboundActivity } | { ok: false; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

/**
 * Parses+validates a raw `activity.ingest.v1` message body into an `InboundActivity`, or a
 * human-readable failure reason otherwise. Never throws.
 */
export function validateActivityIngestMessage(payload: unknown): SchemaValidationResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'message body is not a JSON object' };
  }
  const body = payload as Record<string, unknown>;

  const tenantId = body.tenantId;
  if (typeof tenantId !== 'number' || !Number.isInteger(tenantId)) {
    return { ok: false, reason: 'tenantId is required and must be an integer' };
  }

  const customerId = body.customerId;
  if (!isNonEmptyString(customerId)) {
    return { ok: false, reason: 'customerId is required' };
  }

  const customerIdType = body.customerIdType;
  if (!isNonEmptyString(customerIdType)) {
    return { ok: false, reason: 'customerIdType is required' };
  }

  const activityType = body.activityType;
  if (!isNonEmptyString(activityType)) {
    return { ok: false, reason: 'activityType is required' };
  }

  const activityCategory = body.activityCategory;
  if (!isNonEmptyString(activityCategory)) {
    return { ok: false, reason: 'activityCategory is required' };
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

  // `ARCHITECTURE.md` §8 / `activity_ingest.proto`'s own comment: one of the two is required.
  const transactionType = optionalString(body.transactionType);
  const activityCode = optionalString(body.activityCode);
  if (!transactionType && !activityCode) {
    return { ok: false, reason: 'one of transactionType or activityCode is required' };
  }

  const activityValue = body.activityValue;
  if (!isNonEmptyString(activityValue) || !isValidDecimalString(activityValue)) {
    return {
      ok: false,
      reason: `activityValue "${String(activityValue)}" is not a valid decimal number`,
    };
  }

  const rawPerformedDate = body.activityPerformedDate;
  if (!isNonEmptyString(rawPerformedDate)) {
    return { ok: false, reason: 'activityPerformedDate is required' };
  }
  const activityPerformedDate = parseActivityPerformedDate(rawPerformedDate);
  if (activityPerformedDate === null) {
    return {
      ok: false,
      reason: `activityPerformedDate "${rawPerformedDate}" must be a valid ISO-8601 timestamp with an explicit UTC offset`,
    };
  }

  return {
    ok: true,
    activity: {
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
      merchantCode: optionalString(body.merchantCode),
      activityEventId: optionalString(body.activityEventId),
      correlationId: optionalString(body.correlationId),
      sourceTransport: 'KAFKA',
    },
  };
}
