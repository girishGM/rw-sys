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
 *   4. Resolve the `promo_code_config_version` (T-PC-060, defect fix filed against T-PC-058): an
 *      explicit, caller-supplied `versionNo` wins over the binding's own currently-pinned version
 *      when present and valid for the resolved config — `VERSION_NOT_FOUND` if it isn't valid,
 *      never a silent substitution. Absent → the binding's own pin (`04-API-CONTRACT.md`/
 *      `T-PC-058-version-promo-code-config.md` implementation note 4).
 *   5. Collision-retry loop: generate a candidate code (T-PC-020's `CodeGenerator`), attempt a
 *      transactional insert of `promo_code` (+ `promo_code_outbox` for `KAFKA` transport only,
 *      implementation note 5), retry on a code collision, bounded by `maxRetryAttempts`
 *      (implementation note 3) → `GENERATION_EXHAUSTED` once exhausted. The resolved version's own
 *      `id` is stamped onto the new row (`promo_code.promo_code_config_version_id`) alongside the
 *      existing value snapshot, and its `version_no` is echoed back on the returned result.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { PROMO_CODE_SEQUELIZE } from '../promo-code-config/promo-code-config.constants';
import { PromoCodeConfigService } from '../promo-code-config/promo-code-config.service';
import { CampaignBindingService } from '../campaign-binding/campaign-binding.service';
import { CodeGenerator } from './code-generator';
import type { CodeGenerationConfig } from './code-generator.types';
import { PromoCodeRepository } from './promo-code.repository';
import type { PromoCodeConfigVersion } from './promo-code.repository';
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
      return this.toSuccessResult(existing, await this.resolveVersionNoForPromoCode(existing));
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

    const versionResult = await this.resolveVersion(request, binding.promoCodeConfigId);
    if (versionResult.outcome === 'INVALID_VERSION_NO') {
      return this.failure(
        'INVALID_REQUEST',
        `versionNo "${request.versionNo}" is not a positive integer`,
      );
    }
    if (versionResult.outcome === 'VERSION_NOT_FOUND') {
      return this.failure(
        'VERSION_NOT_FOUND',
        `versionNo "${request.versionNo}" does not resolve to a promo_code_config_version for promoCodeConfigId "${binding.promoCodeConfigId}"`,
      );
    }
    if (versionResult.outcome === 'CONFIG_NOT_BOUND') {
      // Defensive only (implementation note 4/R3): `campaign_promo_config.
      // promo_code_config_version_id` is `NOT NULL` at the DB level (migration
      // `T-PC-058_003_campaign_promo_config_version_pin.ts`), so a resolved, active binding always
      // carries a pin — this branch guards a race between `resolveActiveBinding`'s own read above
      // and this one (the binding was deactivated/rebound in between), not an expected steady state.
      return this.failure(
        'CONFIG_NOT_BOUND',
        `No currently-pinned promo_code_config_version for tenant "${request.tenantId}", bindLevel "${request.bindLevel}", bindRefId "${request.bindRefId}"`,
      );
    }

    return this.generateWithRetry(request, binding.promoCodeConfigId, versionResult.version);
  }

  /**
   * Implementation note 4. An explicit, caller-supplied `versionNo` (frozen-at-grant-time, already
   * resolved upstream) wins over the binding's own currently-pinned version when present — TC-7's
   * "generates under the older, explicitly-requested version" — and is rejected outright, never
   * silently substituted, when it doesn't belong to `promoCodeConfigId` (TC-8). Absent/`null`
   * falls back to the binding's own pin (TC-6) — backward compatible with a caller that predates
   * this field.
   */
  private async resolveVersion(
    request: GenerationRequest,
    promoCodeConfigId: string,
  ): Promise<
    | { outcome: 'RESOLVED'; version: PromoCodeConfigVersion }
    | { outcome: 'VERSION_NOT_FOUND' }
    | { outcome: 'INVALID_VERSION_NO' }
    | { outcome: 'CONFIG_NOT_BOUND' }
  > {
    if (request.versionNo !== null) {
      const versionNoNum = Number(request.versionNo);
      if (!Number.isInteger(versionNoNum) || versionNoNum <= 0) {
        return { outcome: 'INVALID_VERSION_NO' };
      }
      const explicit = await this.repository.findVersionByConfigAndVersionNo(
        request.tenantId,
        promoCodeConfigId,
        versionNoNum,
      );
      if (!explicit) {
        return { outcome: 'VERSION_NOT_FOUND' };
      }
      return { outcome: 'RESOLVED', version: explicit };
    }

    const pinnedVersionId = await this.repository.findActiveBindingVersionId(
      request.tenantId,
      request.bindLevel,
      request.bindRefId,
    );
    if (!pinnedVersionId) {
      return { outcome: 'CONFIG_NOT_BOUND' };
    }
    const pinned = await this.repository.findVersionById(request.tenantId, pinnedVersionId);
    if (!pinned) {
      return { outcome: 'CONFIG_NOT_BOUND' };
    }
    return { outcome: 'RESOLVED', version: pinned };
  }

  /**
   * `promo_code.promo_code_config_version_id` is a FK, not a `version_no` — an idempotent replay
   * (the top-of-method correlationId check) or a correlation-conflict read-back
   * (`generateWithRetry`'s own catch block) only has the already-issued row at hand, neither of
   * which carries `version_no` directly. `null` only for a pre-`T-PC-060` row that predates this
   * column entirely (migration note: "nullable at the DB level for pre-existing rows").
   */
  private async resolveVersionNoForPromoCode(promoCode: PromoCode): Promise<string | null> {
    if (!promoCode.promoCodeConfigVersionId) {
      return null;
    }
    const version = await this.repository.findVersionById(
      promoCode.tenantId,
      promoCode.promoCodeConfigVersionId,
    );
    return version ? String(version.versionNo) : null;
  }

  private async generateWithRetry(
    request: GenerationRequest,
    promoCodeConfigId: string,
    version: PromoCodeConfigVersion,
  ): Promise<GenerationResult> {
    const codeGenConfig: CodeGenerationConfig = {
      characterSet: version.characterSet,
      codeLength: version.codeLength,
      codePrefix: version.codePrefix,
      codePostfix: version.codePostfix,
      excludeAmbiguousChars: version.excludeAmbiguousChars,
    };

    for (let attempt = 1; attempt <= this.maxRetryAttempts; attempt += 1) {
      const code = this.codeGenerator.generate(codeGenConfig);

      try {
        const promoCode = await this.sequelize.transaction(async (transaction) => {
          const created = await this.repository.create(
            {
              promoCodeConfigId,
              promoCodeConfigVersionId: version.id,
              campaignPromoConfigId: null,
              code,
              customerId: request.customerId,
              tenantId: request.tenantId,
              merchantId: request.merchantId,
              rewardValueType: version.rewardValueType,
              rewardValue: version.rewardValue,
              rewardUnit: version.rewardUnit,
              correlationId: request.correlationId,
              transport: request.transport,
              codeExpiryDays: version.codeExpiryDays,
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
                payload: this.buildResultPayload(created, version.versionNo),
              },
              { transaction },
            );
          }

          return created;
        });

        return this.toSuccessResult(promoCode, String(version.versionNo));
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
            return this.toSuccessResult(winner, await this.resolveVersionNoForPromoCode(winner));
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

  private buildResultPayload(promoCode: PromoCode, versionNo: number): Record<string, unknown> {
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
      // T-PC-060: `02-KAFKA-CONTRACTS.md` §5's `versionNo` — a wire-level string, same convention
      // as every other id-shaped field on this payload.
      versionNo: String(versionNo),
    };
  }

  /**
   * `versionNo` is `null` only when resolving it failed to find anything (a pre-`T-PC-060` row
   * being idempotently replayed/read back, per `resolveVersionNoForPromoCode`'s own note) — passed
   * in already-resolved rather than looked up again here, since the two call sites that have it
   * directly at hand (`generateWithRetry`'s own successful insert) would otherwise pay a redundant
   * DB round trip for a value they already computed.
   */
  private toSuccessResult(promoCode: PromoCode, versionNo: string | null): GenerationSuccessResult {
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
      ...(versionNo !== null ? { versionNo } : {}),
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
