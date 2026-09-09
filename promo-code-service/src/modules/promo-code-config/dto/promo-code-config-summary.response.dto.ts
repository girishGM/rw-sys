/**
 * T-PC-011. The thin summary shape `GET /api/v1/promo-code-configs` returns
 * (`04-API-CONTRACT.md` §1, implementation note 1): `id`, `name`, `rewardValueType`,
 * `rewardValue`, `rewardUnit` — and nothing else. `codePrefix`/`codePostfix`/`codeLength`/
 * `characterSet` are never included — "the Maker picks a config by name and payout, not by its
 * internal generation mechanics."
 *
 * **T-PC-058 update**: the source is now `PromoCodeConfigRepository.listSummaries`'s own
 * `PromoCodeConfigListItem` (identity joined to the config's currently-`published`
 * `promo_code_config_version`), not `PromoCodeConfig` directly — that domain shape no longer
 * carries `rewardValueType`/`rewardValue`/`rewardUnit` at all (moved to the version table). Kept
 * as a dedicated, explicit-allowlist mapping function (rather than an object spread with fields
 * deleted) so a future field added to `PromoCodeConfigListItem` can never leak into this response
 * by accident — the allowlist has to be extended on purpose.
 */
import type { PromoCodeConfigListItem } from '../promo-code-config.repository';

export interface PromoCodeConfigSummaryResponseDto {
  id: string;
  name: string;
  rewardValueType: PromoCodeConfigListItem['rewardValueType'];
  rewardValue: string;
  rewardUnit: string;
}

export function toPromoCodeConfigSummary(
  config: PromoCodeConfigListItem,
): PromoCodeConfigSummaryResponseDto {
  return {
    id: config.id,
    name: config.name,
    rewardValueType: config.rewardValueType,
    rewardValue: config.rewardValue,
    rewardUnit: config.rewardUnit,
  };
}
