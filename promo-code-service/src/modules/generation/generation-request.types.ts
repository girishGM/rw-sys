/**
 * T-PC-021. The one transport-neutral input shape `PromoCodeGenerationService.generateCode`
 * accepts (implementation note 1 — no `KafkaMessage`/gRPC-generated type anywhere in this
 * module). Field-for-field the same domain shape as `02-KAFKA-CONTRACTS.md` §3's
 * `promo-code.generate.requested.v1` `data` payload and `03-GRPC-CONTRACT.md` §1's
 * `GenerateCodeRequest`, flattened/camelCased into one plain object both transport adapters
 * (T-PC-030/T-PC-031, Wave 3, out of this task's scope) can build directly off their own wire
 * format with no further translation.
 *
 * `generateCode` accepts `unknown`, not this type directly — same "the service owns structural
 * validity end to end" discipline `PromoCodeConfigService`/`CampaignBindingService` already
 * established (implementation note 8, `INVALID_REQUEST` is a returned result, never a thrown
 * exception, per `03-GRPC-CONTRACT.md` §5: a business outcome is not a protocol-level fault).
 * `parseGenerationRequest` is the one place that boundary is enforced.
 */
import { z } from 'zod';

export const BIND_LEVELS = ['CAMPAIGN', 'TRACKER', 'COMPONENT'] as const;
export type BindLevel = (typeof BIND_LEVELS)[number];

export const TRANSPORTS = ['KAFKA', 'GRPC'] as const;
export type Transport = (typeof TRANSPORTS)[number];

/**
 * `02-KAFKA-CONTRACTS.md` §3: `amount`/`currency` are strings, never floats — money precision.
 * Passed through untouched into the eventual response's traceability; never interpreted by this
 * service's business logic (`metadata`).
 */
export interface ActivityContext {
  amount?: string;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface GenerationRequest {
  correlationId: string;
  tenantId: string;
  bindLevel: BindLevel;
  bindRefId: string;
  customerId: string;
  merchantId: string | null;
  transport: Transport;
  activityContext: ActivityContext | null;
}

const activityContextSchema = z
  .object({
    amount: z.string().min(1).optional(),
    currency: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .nullable()
  .optional();

const generationRequestSchema = z.object({
  correlationId: z.string().uuid('correlationId must be a valid UUID'),
  tenantId: z.string().uuid('tenantId must be a valid UUID'),
  bindLevel: z.enum(BIND_LEVELS, {
    errorMap: () => ({ message: 'bindLevel must be one of CAMPAIGN, TRACKER, COMPONENT' }),
  }),
  bindRefId: z.string().uuid('bindRefId must be a valid UUID'),
  // T-PC-046: bounded to match `promo_code.promo_code.customer_id varchar(120)`
  // (`004_create_promo_code.ts`) — an oversized value must fail structural validation here as
  // `INVALID_REQUEST`, the same "outcome, not exception" discipline every other business failure
  // in this service already uses, rather than reach the DB insert and surface as a raw,
  // unmapped driver error (neither `isCodeCollision()` nor `isCorrelationConflict()`) that
  // rethrows out of `generateWithRetry`/`generateCode` as a protocol-level fault (gRPC `UNKNOWN`)
  // or a uselessly-retried, then DLQ'd, Kafka message — same bound discipline
  // `create-promo-code-config.dto.ts`'s `name: z.string().max(120)` already follows.
  customerId: z
    .string()
    .min(1, 'customerId is required')
    .max(120, 'customerId must be at most 120 characters'),
  merchantId: z.string().uuid('merchantId must be a valid UUID').nullable().optional(),
  transport: z.enum(TRANSPORTS, {
    errorMap: () => ({ message: 'transport must be one of KAFKA, GRPC' }),
  }),
  activityContext: activityContextSchema,
});

export type GenerationRequestValidationResult =
  { ok: true; data: GenerationRequest } | { ok: false; message: string };

/**
 * Implementation note 8: defensive, non-throwing structural validation. Returns a result rather
 * than throwing — `generateCode` turns a failed parse straight into a `FAILED`/`INVALID_REQUEST`
 * `GenerationResult`, the same "outcome, not exception" shape every other business failure this
 * service can produce already uses (never a thrown error a transport adapter would need to catch
 * and re-translate, which would smuggle business logic into the adapter and violate R10).
 */
export function parseGenerationRequest(input: unknown): GenerationRequestValidationResult {
  const result = generationRequestSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, message: `Invalid generation request: ${message}` };
  }
  const parsed = result.data;
  return {
    ok: true,
    data: {
      correlationId: parsed.correlationId,
      tenantId: parsed.tenantId,
      bindLevel: parsed.bindLevel,
      bindRefId: parsed.bindRefId,
      customerId: parsed.customerId,
      merchantId: parsed.merchantId ?? null,
      transport: parsed.transport,
      activityContext: parsed.activityContext ?? null,
    },
  };
}
