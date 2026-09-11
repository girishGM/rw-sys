/**
 * T-INT-054. Structural (shape-only) validation for `POST /api/v1/activities` — the REST option
 * for `SubmitActivity`, field-for-field the same set the gRPC `SubmitActivityRequest` message
 * carries (`activity-ingest.controller.ts`'s own `toInboundActivity`), plus one field the gRPC
 * message does NOT carry: `tenantId`.
 *
 * **Why `tenantId` is a body field here but not on the wire for gRPC**: the gRPC transport resolves
 * `tenantId` from the caller's own mTLS client-certificate identity (`ResolvedIdentityContext`,
 * `MtlsGuard`) — there is no equivalent identity-to-tenant mapping for a shared-bearer-token REST
 * caller (`ingest-token.guard.ts`'s own header explains why this leg intentionally has no per-caller
 * identity, only a single shared secret), so this is the one place in this service's inbound
 * ingestion surface where the caller states its own `tenantId` directly, mirroring
 * `reward-redemption-service`'s own `POST /api/v1/reward-entries` REST DTO (`reward-entry-request.dto.ts`,
 * confirmed by direct read: `tenantId` is a required, caller-trusted body field there too, for the
 * identical "no per-caller identity on this transport" reason).
 *
 * Uses `zod` (already a dependency, `package.json`) — the same established convention
 * `reward-redemption-service`'s own REST DTO documents choosing over `class-validator`/
 * `class-transformer` (neither a dependency anywhere in either service).
 *
 * Reuses `isValidDecimalString`/`parseActivityPerformedDate` from `@/grpc/activity-ingest.validation`
 * (T-RAP-022) — that file's own header already frames itself as shared, transport-agnostic-in-shape
 * validation "so a future Kafka consumer... can import these exact functions rather than
 * re-implementing" (`AGENT-PROTOCOL.md` R5's spirit, applied to this new REST transport instead).
 */
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  isValidDecimalString,
  parseActivityPerformedDate,
} from '@/grpc/activity-ingest.validation';
import type { InboundActivity } from '@/modules/idempotency/inbound-activity.types';

const decimalStringSchema = z
  .string()
  .refine((value) => isValidDecimalString(value), { message: 'must be a valid decimal number' });

/** Parses straight to a `Date` at schema-validation time, mirroring
 * `reward-entry-request.dto.ts`'s own `isoDateSchema` precedent — `toInboundActivity` below never
 * re-parses this field. */
const activityPerformedDateSchema = z.string().transform((value, ctx) => {
  const parsed = parseActivityPerformedDate(value);
  if (parsed === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must be a valid ISO-8601 timestamp with an explicit UTC offset',
    });
    return z.NEVER;
  }
  return parsed;
});

const requestSchema = z
  .object({
    tenantId: z
      .number({ invalid_type_error: 'tenantId is required and must be a number' })
      .int('tenantId must be an integer')
      .positive('tenantId must be a positive integer'),
    customerId: z.string().min(1, 'customerId is required'),
    customerIdType: z.string().min(1, 'customerIdType is required'),
    activityPerformedDate: activityPerformedDateSchema,
    // One-of with `activityCode` — same rule as the gRPC controller's own
    // `toInboundActivity`, enforced by the object-level `.refine()` below.
    transactionType: z.string().min(1).optional(),
    activityCode: z.string().min(1).optional(),
    activityType: z.string().min(1, 'activityType is required'),
    activityCategory: z.string().min(1, 'activityCategory is required'),
    activityValue: decimalStringSchema,
    activityValueUnit: z.string().min(1, 'activityValueUnit is required'),
    channel: z.string().min(1, 'channel is required'),
    activityPerformedEnv: z.string().min(1, 'activityPerformedEnv is required'),
    activityName: z.string().min(1, 'activityName is required'),
    merchantCode: z.string().min(1).optional(),
    activityEventId: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.transactionType) || Boolean(data.activityCode), {
    message: 'one of transactionType or activityCode is required',
    path: ['transactionType'],
  });

export interface ActivityIngestRequestDto {
  tenantId: number;
  customerId: string;
  customerIdType: string;
  activityPerformedDate: Date;
  transactionType?: string;
  activityCode?: string;
  activityType: string;
  activityCategory: string;
  activityValue: string;
  activityValueUnit: string;
  channel: string;
  activityPerformedEnv: string;
  activityName: string;
  merchantCode?: string;
  activityEventId?: string;
  correlationId?: string;
}

/** Throws a real `BadRequestException` (-> HTTP `400`) on any structural failure — never a
 * partially-parsed return, matching `reward-entry-request.dto.ts`'s own "malformed body must never
 * reach the domain service" contract. */
export function parseActivityIngestRequest(input: unknown): ActivityIngestRequestDto {
  const result = requestSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException(`Invalid activity ingest request: ${message}`);
  }
  return result.data;
}

/** The explicit, typed mapping onto the one shared `InboundActivity` shape both the gRPC controller
 * and (once T-RAP-023 lands) the Kafka consumer also construct — `ActivityIngestionService.ingest()`
 * (T-RAP-021) itself is transport-agnostic (`AGENT-PROTOCOL.md` R5), so this is the entire extent of
 * this file's own transport-specific translation. */
export function toInboundActivity(dto: ActivityIngestRequestDto): InboundActivity {
  return {
    tenantId: dto.tenantId,
    customerId: dto.customerId,
    customerIdType: dto.customerIdType,
    activityPerformedDate: dto.activityPerformedDate,
    transactionType: dto.transactionType,
    activityCode: dto.activityCode,
    activityType: dto.activityType,
    activityCategory: dto.activityCategory,
    activityValue: dto.activityValue,
    activityValueUnit: dto.activityValueUnit,
    channel: dto.channel,
    activityPerformedEnv: dto.activityPerformedEnv,
    activityName: dto.activityName,
    merchantCode: dto.merchantCode,
    activityEventId: dto.activityEventId,
    correlationId: dto.correlationId,
    sourceTransport: 'REST',
  };
}
