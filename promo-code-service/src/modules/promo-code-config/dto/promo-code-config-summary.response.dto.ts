/**
 * T-PC-011. The thin summary shape `GET /api/v1/promo-code-configs` returns
 * (`04-API-CONTRACT.md` §1, implementation note 1): `id`, `name`, `rewardValueType`,
 * `rewardValue`, `rewardUnit` — and nothing else. `codePrefix`/`codePostfix`/`codeLength`/
 * `characterSet` are never included, even though `PromoCodeConfig` (T-PC-010's domain shape)
 * carries them — "the Maker picks a config by name and payout, not by its internal generation
 * mechanics."
 *
 * A dedicated, explicit-allowlist mapping function (rather than an object spread with fields
 * deleted) so a future field added to `PromoCodeConfig` can never leak into this response by
 * accident — the allowlist has to be extended on purpose.
 */
import type { PromoCodeConfig } from '../promo-code-config.entity';

export interface PromoCodeConfigSummaryResponseDto {
  id: string;
  name: string;
  rewardValueType: PromoCodeConfig['rewardValueType'];
  rewardValue: string;
  rewardUnit: string;
}

export function toPromoCodeConfigSummary(
  config: PromoCodeConfig,
): PromoCodeConfigSummaryResponseDto {
  return {
    id: config.id,
    name: config.name,
    rewardValueType: config.rewardValueType,
    rewardValue: config.rewardValue,
    rewardUnit: config.rewardUnit,
  };
}
