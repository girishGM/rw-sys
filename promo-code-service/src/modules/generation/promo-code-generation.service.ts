/**
 * T-PC-021. `PromoCodeGenerationService` — the single domain method both the Kafka consumer
 * (T-PC-030) and the gRPC server (T-PC-031) call (`ARCHITECTURE.md` §6, `02-KAFKA-CONTRACTS.md`
 * §4). "The one non-negotiable architectural rule for Wave 2/3": neither transport adapter may
 * contain generation business logic (R10) — everything below is transport-neutral, no
 * `KafkaMessage`/gRPC-generated type appears anywhere in this file.
 *
 * Control flow, in order (implementation note 2 — idempotency first, always):
 *   1. Validate the request shape → `FAILED`/`INVALID_REQUEST` if malformed, before any DB work.
 *   2. Idempotency check on `correlationId` → found means "do not generate again", read back and
 *      return the same result (`02-KAFKA-CONTRACTS.md` §4).
 *   3. Resolve the binding (`CampaignBindingService.resolveActiveBinding`, T-PC-012) →
 *      `CONFIG_NOT_BOUND`/`CONFIG_INACTIVE` mapped straight through, never collapsed
 *      (implementation note 7).
 *   4. Collision-retry loop: generate a candidate code (T-PC-020's `CodeGenerator`), attempt a
 *      transactional insert of `promo_code` (+ `promo_code_outbox` for `KAFKA` transport only,
 *      implementation note 5), retry on a code collision, bounded by `maxRetryAttempts`
 *      (implementation note 3) → `GENERATION_EXHAUSTED` once exhausted.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { PROMO_CODE_SEQUELIZE } from '../promo-code-config/promo-code-config.constants';
import { PromoCodeConfigService } from '../promo-code-config/promo-code-config.service';
import { CampaignBindingService } from '../campaign-binding/campaign-binding.service';
import { CodeGenerator } from './code-generator';
import type { CodeGenerationConfig } from './code-generator.types';
import { PromoCodeRepository } from './promo-code.repository';
import type { PromoCode } from './promo-code.entity';
import { parseGenerationRequest } from './generation-request.types';
import type { GenerationRequest } from './generation-request.types';
import type {
  GenerationFailureResult,
  GenerationResult,
  GenerationSuccessResult,
} from './generation-result.types';
import type { GenerationErrorCode } from './generation-error-codes';
import {
  DEFAULT_GENERATION_MAX_RETRY_ATTEMPTS,
  GENERATE_RESULT_TOPIC,
  GENERATION_MAX_RETRY_ATTEMPTS,
} from './promo-code-generation.constants';

@Injectable()
export class PromoCodeGenerationService {
  private readonly logger = new Logger(PromoCodeGenerationService.name);

  constructor(
    private readonly repository: PromoCodeRepository,
    private readonly campaignBindingService: CampaignBindingService,
    private readonly promoCodeConfigService: PromoCodeConfigService,
    private readonly codeGenerator: CodeGenerator,
    @Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize,
    @Inject(GENERATION_MAX_RETRY_ATTEMPTS)
    private readonly maxRetryAttempts: number = DEFAULT_GENERATION_MAX_RETRY_ATTEMPTS,
  ) {}

  /**
   * The one entry point (Objective). Accepts `unknown`, not `GenerationRequest` directly — same
   * "the service owns structural validity end to end" discipline `PromoCodeConfigService`/
   * `CampaignBindingService` already established. Never throws for an expected business outcome:
   * every failure mode this service recognises comes back as a `FAILED` `GenerationResult`, per
   * `03-GRPC-CONTRACT.md` §5 ("a business outcome is not the same thing as a protocol-level
   * fault"). An unexpected error (a DB outage, an unmapped driver error) still propagates as a
   * thrown exception — that is a transport/infra fault, not a business outcome, and each
   * transport adapter maps *that* to its own protocol-level fault (an HTTP 500 equivalent, a
   * gRPC `INTERNAL`, a DLQ-worthy poison message), never to a fabricated `errorCode` here.
   */
  async generateCode(input: unknown): Promise<GenerationResult> {
    const parsed = parseGenerationRequest(input);
    if (!parsed.ok) {
      return this.failure('INVALID_REQUEST', parsed.message);
    }
    const request = parsed.data;

    // Implementation note 2: idempotency check first, before any binding resolution or
    // generation work.
    const existing = await this.repository.findByCorrelationId(
      request.tenantId,
      request.correlationId,
    );
    if (existing) {
      return this.toSuccessResult(existing);
    }

    const binding = await this.campaignBindingService.resolveActiveBinding(
      request.tenantId,
      request.bindLevel,
      request.bindRefId,
    );
    if (binding.outcome === 'NOT_BOUND') {
      return this.failure(
        'CONFIG_NOT_BOUND',
        `No active binding for tenant "${request.tenantId}", bindLevel "${request.bindLevel}", bindRefId "${request.bindRefId}"`,
      );
    }
    if (binding.outcome === 'CONFIG_INACTIVE') {
      return this.failure(
        'CONFIG_INACTIVE',
        `promoCodeConfigId "${binding.promoCodeConfigId}" is bound but not ACTIVE`,
      );
    }

    const config = await this.promoCodeConfigService.findById(
      request.tenantId,
      binding.promoCodeConfigId,
    );
    if (!config || config.status !== 'ACTIVE') {
      // Defensive: the config was ACTIVE a moment ago in resolveActiveBinding's own check, but a
      // concurrent archive between that check and this read is possible — re-validated here
      // rather than trusted (R3), same distinct outcome as the initial check.
      return this.failure(
        'CONFIG_INACTIVE',
        `promoCodeConfigId "${binding.promoCodeConfigId}" is bound but not ACTIVE`,
      );
    }

    return this.generateWithRetry(request, config);
  }

  private async generateWithRetry(
    request: GenerationRequest,
    config: {
      id: string;
      characterSet: CodeGenerationConfig['characterSet'];
      codeLength: number;
      codePrefix: string | null;
      codePostfix: string | null;
      excludeAmbiguousChars: boolean;
      rewardValueType: string;
      rewardValue: string;
      rewardUnit: string;
      codeExpiryDays: number | null;
    },
  ): Promise<GenerationResult> {
    for (let attempt = 1; attempt <= this.maxRetryAttempts; attempt += 1) {
      const code = this.codeGenerator.generate({
        characterSet: config.characterSet,
        codeLength: config.codeLength,
        codePrefix: config.codePrefix,
        codePostfix: config.codePostfix,
        excludeAmbiguousChars: config.excludeAmbiguousChars,
      });

      try {
        const promoCode = await this.sequelize.transaction(async (transaction) => {
          const created = await this.repository.create(
            {
              promoCodeConfigId: config.id,
              campaignPromoConfigId: null,
              code,
              customerId: request.customerId,
              tenantId: request.tenantId,
              merchantId: request.merchantId,
              rewardValueType: config.rewardValueType,
              rewardValue: config.rewardValue,
              rewardUnit: config.rewardUnit,
              correlationId: request.correlationId,
              transport: request.transport,
              codeExpiryDays: config.codeExpiryDays,
            },
            { transaction },
          );

          // Implementation note 5: only ever for a KAFKA-transport request — the GRPC caller is
          // holding the connection open, there is no delivery gap to bridge.
          if (request.transport === 'KAFKA') {
            await this.repository.createOutboxRow(
              {
                promoCodeId: created.id,
                topic: GENERATE_RESULT_TOPIC,
                payload: this.buildResultPayload(created),
              },
              { transaction },
            );
          }

          return created;
        });

        return this.toSuccessResult(promoCode);
      } catch (error) {
        if (this.repository.isCorrelationConflict(error)) {
          // TC-13: a concurrent call for the same correlationId committed first. Not a
          // collision to retry past — read back the row the other caller just committed and
          // return its result, never a second insert attempt.
          const winner = await this.repository.findByCorrelationId(
            request.tenantId,
            request.correlationId,
          );
          if (winner) {
            return this.toSuccessResult(winner);
          }
          throw error;
        }
        if (this.repository.isCodeCollision(error)) {
          this.logger.warn(
            `promo_code.code collision on attempt ${attempt}/${this.maxRetryAttempts} for correlationId "${request.correlationId}" — regenerating`,
          );
          continue;
        }
        throw error;
      }
    }

    this.logger.warn(
      `GENERATION_EXHAUSTED for correlationId "${request.correlationId}" after ${this.maxRetryAttempts} attempts`,
    );
    return this.failure(
      'GENERATION_EXHAUSTED',
      `Exhausted ${this.maxRetryAttempts} collision-retry attempts`,
    );
  }

  private buildResultPayload(promoCode: PromoCode): Record<string, unknown> {
    // `02-KAFKA-CONTRACTS.md` §5's `data` shape — the envelope itself (`eventId`/`occurredAt`/
    // `source`/etc.) is built fresh at publish time by T-PC-022, not stored here (that task's own
    // implementation note 5: "keeps occurredAt/eventId honest about when the send actually
    // happened, not when the outbox row was first created").
    return {
      status: 'SUCCESS',
      promoCodeId: promoCode.id,
      code: promoCode.code,
      rewardValueType: promoCode.rewardValueType,
      rewardValue: promoCode.rewardValue,
      rewardUnit: promoCode.rewardUnit,
      expiresAt: promoCode.expiresAt ? promoCode.expiresAt.toISOString() : null,
      errorCode: null,
      errorMessage: null,
    };
  }

  private toSuccessResult(promoCode: PromoCode): GenerationSuccessResult {
    return {
      status: 'SUCCESS',
      promoCodeId: promoCode.id,
      code: promoCode.code,
      rewardValueType: promoCode.rewardValueType as GenerationSuccessResult['rewardValueType'],
      rewardValue: promoCode.rewardValue,
      rewardUnit: promoCode.rewardUnit,
      expiresAt: promoCode.expiresAt,
      errorCode: null,
      errorMessage: null,
    };
  }

  private failure(errorCode: GenerationErrorCode, errorMessage: string): GenerationFailureResult {
    return {
      status: 'FAILED',
      promoCodeId: null,
      code: null,
      rewardValueType: null,
      rewardValue: null,
      rewardUnit: null,
      expiresAt: null,
      errorCode,
      errorMessage,
    };
  }
}
