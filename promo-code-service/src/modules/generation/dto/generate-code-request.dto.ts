/**
 * T-PC-056. Structural (shape-only) validation for `POST /api/v1/promo-codes/generate`'s request
 * body — field-for-field the same set gRPC's `GenerateCodeRequest` carries
 * (`03-GRPC-CONTRACT.md` §1) and the Kafka `generate.requested.v1` payload carries
 * (`02-KAFKA-CONTRACTS.md` §3), just JSON instead of proto/Kafka envelope. `transport` is not a
 * body field here — this controller hardcodes it to `'REST'` itself (implementation note 1),
 * exactly as the gRPC controller hardcodes `'GRPC'` and the Kafka consumer hardcodes `'KAFKA'`.
 *
 * Deliberately **shallow** — presence/type/enum-membership only, not the deeper semantic rules
 * `generation-request.types.ts`'s own `parseGenerationRequest` already enforces (UUID-shaped
 * `correlationId`, exact length bounds). This is what implementation note 2's "fails
 * class-validator/zod before reaching the service" distinction actually means in practice: a
 * missing/wrong-typed required field never reaches `PromoCodeGenerationService.generateCode()` at
 * all (TC-6, a real HTTP `400`), while a structurally-present-but-semantically-invalid value (e.g.
 * a non-UUID `correlationId`) still reaches the service and comes back as an ordinary `200`
 * `FAILED`/`INVALID_REQUEST` business outcome — the exact same result gRPC/Kafka would produce for
 * identical input (TC-7 cross-transport parity). This split is deliberately owned here, not
 * merged into `generation-request.types.ts` (T-PC-021, R8) — this file only ever narrows what
 * reaches that shared validator, never widens or replaces it.
 */
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { BIND_LEVELS, type BindLevel } from '../generation-request.types';

const activityContextSchema = z
  .object({
    amount: z.string().min(1).optional(),
    currency: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .optional();

const generateCodeRequestSchema = z.object({
  correlationId: z.string().min(1, 'correlationId is required'),
  tenantId: z.string().min(1, 'tenantId is required'),
  bindLevel: z.enum(BIND_LEVELS, {
    errorMap: () => ({ message: 'bindLevel must be one of CAMPAIGN, TRACKER, COMPONENT' }),
  }),
  bindRefId: z.string().min(1, 'bindRefId is required'),
  customerId: z.string().min(1, 'customerId is required'),
  merchantId: z.string().min(1).optional(),
  activityContext: activityContextSchema,
});

export interface GenerateCodeRequestDto {
  correlationId: string;
  tenantId: string;
  bindLevel: BindLevel;
  bindRefId: string;
  customerId: string;
  merchantId?: string;
  activityContext?: {
    amount?: string;
    currency?: string;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Throws a real NestJS `BadRequestException` (→ HTTP `400`) on any structural failure — never a
 * `GenerationResult`-shaped return, since a malformed body must not reach
 * `PromoCodeGenerationService` at all (TC-6).
 */
export function parseGenerateCodeRequest(input: unknown): GenerateCodeRequestDto {
  const result = generateCodeRequestSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException(`Invalid generate code request: ${message}`);
  }
  return result.data;
}
