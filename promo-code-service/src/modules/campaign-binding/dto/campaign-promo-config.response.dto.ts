/**
 * T-PC-012. `04-API-CONTRACT.md` §2's `201` response shape — "the created `campaign_promo_config`
 * row (`01-DATABASE.md` §2 shape)". A thin, explicit transform (rather than returning the domain
 * object directly, as `PromoCodeConfigController`'s `create`/`update` do) specifically to fix the
 * wire shape independently of whatever fields `CampaignPromoConfig` happens to carry internally
 * later, and to make the `Date` → ISO-string wire format an explicit, testable contract rather
 * than an accident of Express's default `JSON.stringify` behaviour.
 */
import type { CampaignPromoConfig } from '../campaign-promo-config.entity';

export interface CampaignPromoConfigResponseDto {
  id: string;
  promoCodeConfigId: string;
  tenantId: string;
  bindLevel: string;
  bindRefId: string;
  status: string;
  boundBy: string;
  boundAt: string;
  updatedAt: string;
}

export function toCampaignPromoConfigResponse(
  domain: CampaignPromoConfig,
): CampaignPromoConfigResponseDto {
  return {
    id: domain.id,
    promoCodeConfigId: domain.promoCodeConfigId,
    tenantId: domain.tenantId,
    bindLevel: domain.bindLevel,
    bindRefId: domain.bindRefId,
    status: domain.status,
    boundBy: domain.boundBy,
    boundAt: domain.boundAt.toISOString(),
    updatedAt: domain.updatedAt.toISOString(),
  };
}
