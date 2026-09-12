/**
 * T-RR-013. Structural (shape-only) validation for `POST /api/v1/reward-entries`'s request body —
 * field-for-field the same set the gRPC `RewardEntry` message carries (`03-GRPC-CONTRACT.md` §1)
 * and the Kafka `reward.entry.created.v1` payload carries (`02-KAFKA-CONTRACTS.md` §1), just JSON
 * instead of proto/Kafka envelope (`04-REST-CONTRACT.md` §1's own JSON example). `ingestionChannel`
 * is not a body field here — this controller hardcodes it to `'REST'` itself
 * (`toRewardEntryIngestDto` below), exactly as the gRPC controller hardcodes `'GRPC'` and the Kafka
 * consumer hardcodes `'KAFKA'`.
 *
 * Uses `zod` (already a dependency of this service, `package.json`) rather than
 * `class-validator`/`class-transformer` (neither is a dependency anywhere in this service) —
 * mirroring promo-code-service's own established convention for this exact situation
 * (`promo-code-service/src/modules/generation/dto/generate-code-request.dto.ts`'s own
 * `parseGenerateCodeRequest`, confirmed by direct read, per this task's own implementation note 1:
 * "check its real code for the established convention rather than introducing a new one").
 *
 * `activity_value`/`reward_value` (decimal-as-string) and `activity_performed_date`/
 * `reward_entry_date` (full ISO-8601 with an explicit zone offset) reuse
 * `isValidDecimalString`/`parseIsoDateWithOffset` from `@/grpc/reward-ingest.validation` — that
 * file's own header names this REST controller by task id as one of the two intended reusers, so
 * this channel enforces byte-for-byte the same two rules the gRPC controller does (R10's "identical
 * behavior regardless of channel", applied to shared *validation* specifically).
 *
 * Throws a real NestJS `BadRequestException` (→ HTTP `400`) on any structural failure — never a
 * `RewardEntryRequestDto`-shaped return with an error inside it, since a malformed body must never
 * reach `RewardIngestionService.ingest()` at all (TC-5/TC-6).
 */
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  isValidDecimalString,
  parseIsoDateWithOffset,
  parsePromoCodeConfigVersionNo,
  parseRewardKind,
} from '@/grpc/reward-ingest.validation';
import type { RewardKind } from '@/grpc/reward-ingest.validation';
import type {
  IngestionChannel,
  RewardEntryIngestDto,
} from '@/modules/reward-ingestion/reward-entry-ingest.dto';

const decimalStringSchema = z
  .string()
  .refine((value) => isValidDecimalString(value), { message: 'must be a valid decimal number' });

/** Parses straight to a `Date` at schema-validation time — `toRewardEntryIngestDto` below never
 * re-parses these fields, so there is exactly one place this service ever calls
 * `parseIsoDateWithOffset` per date field, not two. */
const isoDateSchema = z.string().transform((value, ctx) => {
  const parsed = parseIsoDateWithOffset(value);
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
    id: z.string().min(1, 'id is required'),
    correlationId: z.string().min(1, 'correlationId is required'),
    tenantId: z
      .number({ invalid_type_error: 'tenantId is required and must be a number' })
      .int('tenantId must be an integer')
      .positive('tenantId must be a positive integer'),
    customerId: z.string().min(1, 'customerId is required'),
    customerIdType: z.string().min(1, 'customerIdType is required'),
    activityPerformedDate: isoDateSchema,
    // One-of with `activityCode` (`03-GRPC-CONTRACT.md` §1's own comment, mirrored here) — either
    // may be `null`/absent, enforced by the object-level `.refine()` below.
    transactionType: z.string().min(1).nullable().optional(),
    activityCode: z.string().min(1).nullable().optional(),
    activityType: z.string().min(1, 'activityType is required'),
    activityCategory: z.string().min(1, 'activityCategory is required'),
    activityValue: decimalStringSchema,
    activityValueUnit: z.string().min(1, 'activityValueUnit is required'),
    channel: z.string().min(1, 'channel is required'),
    activityPerformedEnv: z.string().min(1, 'activityPerformedEnv is required'),
    activityName: z.string().min(1, 'activityName is required'),
    campaignCode: z.string().min(1, 'campaignCode is required'),
    trackerCode: z.string().min(1, 'trackerCode is required'),
    trackerComponentCode: z.string().min(1, 'trackerComponentCode is required'),
    merchantCode: z.string().min(1).nullable().optional(),
    rewardCode: z.string().min(1, 'rewardCode is required'),
    rewardCategory: z.string().min(1, 'rewardCategory is required'),
    rewardValue: decimalStringSchema,
    // T-INT-046: some reward kinds (`PROMO_CODE`/`POINTS`) have no fixed currency/point unit by
    // design — an empty string or an absent field both mean "no unit for this reward kind", not a
    // malformed request, the same tolerance this schema already gives
    // `transactionType`/`activityCode`/`merchantCode`. Never invent a placeholder unit string
    // (task's own "Scope" section) — `''`/absent both normalize to `''` below.
    rewardValueUnit: z.string().nullable().optional(),
    rewardEntryDate: isoDateSchema,
    completionCycle: z
      .number({ invalid_type_error: 'completionCycle is required and must be an integer' })
      .int('completionCycle must be an integer'),
    // T-INT-058: descriptive-only, never mandatory, never rejected for an unrecognized value —
    // a plain `z.string()` here (not `z.enum(REWARD_KIND_VALUES)`), since normalization to a known
    // `RewardKind` (or `null`) happens in `parseRewardEntryRequest` below via the same shared,
    // never-throwing `parseRewardKind` the gRPC/Kafka legs also use.
    rewardKind: z.string().nullable().optional(),
    promoCodeConfigId: z.string().nullable().optional(),
    promoCodeConfigVersionNo: z.number().nullable().optional(),
  })
  .refine((data) => Boolean(data.transactionType) || Boolean(data.activityCode), {
    message: 'one of transactionType or activityCode is required',
    path: ['transactionType'],
  });

export interface RewardEntryRequestDto {
  id: string;
  correlationId: string;
  tenantId: number;
  customerId: string;
  customerIdType: string;
  activityPerformedDate: Date;
  transactionType: string | null;
  activityCode: string | null;
  activityType: string;
  activityCategory: string;
  activityValue: string;
  activityValueUnit: string;
  channel: string;
  activityPerformedEnv: string;
  activityName: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  merchantCode: string | null;
  rewardCode: string;
  rewardCategory: string;
  rewardValue: string;
  rewardValueUnit: string;
  rewardEntryDate: Date;
  completionCycle: number;
  /** T-INT-058 — see `RewardEntryIngestDto`'s own doc comment for the full field-level reasoning;
   * this REST-facing shape mirrors it exactly. */
  rewardKind: RewardKind | null;
  promoCodeConfigId: string | null;
  promoCodeConfigVersionNo: number | null;
}

export function parseRewardEntryRequest(input: unknown): RewardEntryRequestDto {
  const result = requestSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException(`Invalid reward entry request: ${message}`);
  }
  return {
    ...result.data,
    transactionType: result.data.transactionType ?? null,
    activityCode: result.data.activityCode ?? null,
    merchantCode: result.data.merchantCode ?? null,
    // T-INT-046: `rewardValueUnit` is a required `string` (never nullable) on
    // `RewardEntryRequestDto`/`RewardEntryIngestDto` — normalize `null`/absent to `''`, the same
    // "no unit for this reward kind" convention the gRPC/Kafka legs also use.
    rewardValueUnit: result.data.rewardValueUnit ?? '',
    // T-INT-058: same shared, never-throwing normalizers the gRPC/Kafka legs use — absent, `null`,
    // or an unrecognized `rewardKind` string all degrade to `null`, never a 400 (descriptive-only
    // metadata, never mandatory).
    rewardKind: parseRewardKind(result.data.rewardKind),
    promoCodeConfigId: result.data.promoCodeConfigId ?? null,
    promoCodeConfigVersionNo: parsePromoCodeConfigVersionNo(result.data.promoCodeConfigVersionNo),
  };
}

const REST_INGESTION_CHANNEL: IngestionChannel = 'REST';

/**
 * The explicit, typed mapping from the validated request DTO to the one shared
 * `RewardEntryIngestDto` every channel calls `RewardIngestionService.ingest()` with (task
 * implementation note 6) — never a loose spread/cast, so a future field added to either type
 * without updating this function is a compile error, not a silently-dropped field.
 */
export function toRewardEntryIngestDto(dto: RewardEntryRequestDto): RewardEntryIngestDto {
  return {
    id: dto.id,
    correlationId: dto.correlationId,
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
    campaignCode: dto.campaignCode,
    trackerCode: dto.trackerCode,
    trackerComponentCode: dto.trackerComponentCode,
    merchantCode: dto.merchantCode,
    rewardCode: dto.rewardCode,
    rewardCategory: dto.rewardCategory,
    rewardValue: dto.rewardValue,
    rewardValueUnit: dto.rewardValueUnit,
    rewardEntryDate: dto.rewardEntryDate,
    completionCycle: dto.completionCycle,
    ingestionChannel: REST_INGESTION_CHANNEL,
    rewardKind: dto.rewardKind,
    promoCodeConfigId: dto.promoCodeConfigId,
    promoCodeConfigVersionNo: dto.promoCodeConfigVersionNo,
  };
}
