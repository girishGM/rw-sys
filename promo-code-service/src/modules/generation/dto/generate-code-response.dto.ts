/**
 * T-PC-056. Maps the transport-neutral `GenerationResult` (T-PC-021) onto this endpoint's REST
 * JSON response shape — field-for-field the same set as gRPC's `GenerateCodeResponse`
 * (`03-GRPC-CONTRACT.md` §1/§5), but `null` for an absent value rather than proto3's `''`
 * convention (a plain JSON body has no reason to inherit proto's "no null strings" limitation).
 * Always HTTP `200` — `status` inside the body carries the business outcome
 * (`SUCCESS`/`FAILED`), exactly gRPC's own "a business outcome is not the same thing as a
 * protocol-level fault" convention (`03-GRPC-CONTRACT.md` §5), inherited here rather than
 * reinvented (implementation note 2).
 */
import type { GenerationResult } from '../generation-result.types';

export interface GenerateCodeResponseDto {
  status: 'SUCCESS' | 'FAILED';
  promoCodeId: string | null;
  code: string | null;
  rewardValueType: string | null;
  rewardValue: string | null;
  rewardUnit: string | null;
  /** ISO 8601, `null` if the config never expires or the request failed. */
  expiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export function toGenerateCodeResponseDto(result: GenerationResult): GenerateCodeResponseDto {
  return {
    status: result.status,
    promoCodeId: result.promoCodeId,
    code: result.code,
    rewardValueType: result.rewardValueType,
    rewardValue: result.rewardValue,
    rewardUnit: result.rewardUnit,
    expiresAt: result.expiresAt ? result.expiresAt.toISOString() : null,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}
