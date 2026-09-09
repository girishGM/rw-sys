/**
 * T-PC-021. The one transport-neutral output shape `PromoCodeGenerationService.generateCode`
 * returns (implementation note 1). Field-for-field the same domain shape as
 * `02-KAFKA-CONTRACTS.md` §5's `promo-code.generate.result.v1` `data` payload and
 * `03-GRPC-CONTRACT.md` §1's `GenerateCodeResponse` — both transport adapters map this straight
 * onto their own wire format with no further translation.
 *
 * A discriminated union on `status`, not one flat interface with nullable success fields sprinkled
 * next to nullable error fields: `SUCCESS` fields are only ever readable when `status ===
 * 'SUCCESS'`, `errorCode`/`errorMessage` only when `status === 'FAILED'` — the type system, not a
 * runtime convention, prevents a caller from reading `code` off a `FAILED` result.
 */
import type { RewardValueType } from '../promo-code-config/promo-code-config.entity';
import type { GenerationErrorCode } from './generation-error-codes';

export interface GenerationSuccessResult {
  status: 'SUCCESS';
  promoCodeId: string;
  code: string;
  rewardValueType: RewardValueType;
  rewardValue: string;
  rewardUnit: string;
  /** `null` when the resolved config's `codeExpiryDays` was `null` (never expires) — TC-17. */
  expiresAt: Date | null;
  errorCode: null;
  errorMessage: null;
  /**
   * T-PC-060 (defect fix filed against T-PC-058). The resolved `promo_code_config_version.
   * version_no` this code was actually generated under (`02-KAFKA-CONTRACTS.md` §5 /
   * `03-GRPC-CONTRACT.md` §1's `version_no` echo). **Optional, not always present** — deliberately,
   * so this additive field never breaks an existing literal `GenerationResult` object built by a
   * file outside this task's scope (`src/grpc/promo-code.controller.ts`'s own `successResult`
   * fixture, `src/observability/metrics/generation-latency.instrumentation.spec.ts`,
   * `test/messaging/generate-requested.consumer.spec.ts` — none declare this field, none needed
   * to). Every code path in `PromoCodeGenerationService` itself always populates a real value.
   */
  versionNo?: string;
}

export interface GenerationFailureResult {
  status: 'FAILED';
  promoCodeId: null;
  code: null;
  rewardValueType: null;
  rewardValue: null;
  rewardUnit: null;
  expiresAt: null;
  errorCode: GenerationErrorCode;
  errorMessage: string;
  /** Never populated on a failure — see `GenerationSuccessResult.versionNo`'s own note on why
   * this is optional rather than a forced `null` literal like every sibling field above. */
  versionNo?: undefined;
}

export type GenerationResult = GenerationSuccessResult | GenerationFailureResult;
