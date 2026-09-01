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
}

export type GenerationResult = GenerationSuccessResult | GenerationFailureResult;
