/**
 * T-PC-056. `POST /api/v1/promo-codes/generate` — a REST transport for code generation, alongside
 * gRPC (T-PC-031) and Kafka (T-PC-030), added because Render's edge-terminated TLS makes this
 * service's mTLS-based gRPC server impractical to reach from a Render-hosted caller
 * (`04-API-CONTRACT.md` §5 records the full architect decision).
 *
 * **A thin adapter — literally nothing but request parsing, calling
 * `PromoCodeGenerationService.generateCode(...)`, and response shaping** (R10, implementation
 * note 4). No idempotency handling, no collision retry, no binding resolution here — all of that
 * already exists in `PromoCodeGenerationService` (T-PC-021) and belongs there, not here. A fix to
 * a bug in that shared logic is automatically a fix for every transport, because this controller
 * is not a second implementation of any of it.
 *
 * Guarded by `GenerationServiceTokenGuard` — a **distinct** secret from
 * `InternalServiceTokenGuard`'s `INTERNAL_SERVICE_TOKEN` (R11); the portal never receives this
 * one. Nest's own pipeline runs guards before a handler body ever executes, so an unauthenticated
 * request is rejected `401` before this controller's own body-shape validation ever runs (TC-6's
 * "your call which runs first" — documented here: **guard first**, always).
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { PromoCodeGenerationService } from './promo-code-generation.service';
import { GenerationServiceTokenGuard } from './generation-service-token.guard';
import { parseGenerateCodeRequest } from './dto/generate-code-request.dto';
import {
  toGenerateCodeResponseDto,
  type GenerateCodeResponseDto,
} from './dto/generate-code-response.dto';

@Controller('api/v1/promo-codes')
@UseGuards(GenerationServiceTokenGuard)
export class PromoCodeGenerateController {
  constructor(private readonly generationService: PromoCodeGenerationService) {}

  // Always `200` — `status`/`errorCode` inside the body carry the business outcome
  // (`GenerateCodeResponseDto`'s own header). Real HTTP error statuses are reserved for `401`
  // (this class's `@UseGuards`), `400` (thrown by `parseGenerateCodeRequest` below, before
  // `generationService` is ever called — TC-6), and `500` (an unexpected/unmapped exception,
  // Nest's own default exception handling).
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  async generate(@Body() body: Record<string, unknown>): Promise<GenerateCodeResponseDto> {
    const parsed = parseGenerateCodeRequest(body);

    const result = await this.generationService.generateCode({
      correlationId: parsed.correlationId,
      tenantId: parsed.tenantId,
      bindLevel: parsed.bindLevel,
      bindRefId: parsed.bindRefId,
      customerId: parsed.customerId,
      merchantId: parsed.merchantId ?? null,
      // The one field this adapter itself supplies rather than reads off the body — same
      // convention the gRPC controller (`transport: 'GRPC'`) and Kafka consumer
      // (`transport: 'KAFKA'`) already follow.
      transport: 'REST',
      activityContext: parsed.activityContext
        ? {
            amount: parsed.activityContext.amount,
            currency: parsed.activityContext.currency,
            metadata: parsed.activityContext.metadata,
          }
        : null,
    });

    return toGenerateCodeResponseDto(result);
  }
}
