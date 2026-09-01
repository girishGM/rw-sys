/**
 * T-PC-012. `promo_code.campaign_promo_config` — which recipe is attached to which
 * campaign/tracker/component (`01-DATABASE.md` §2). Same row-shape/domain-shape split as
 * `promo-code-config.entity.ts` (T-PC-010) — raw snake_case straight off Postgres vs. the
 * camelCase shape every layer above the repository actually works with.
 *
 * `boundAt`/`updatedAt` are kept as real `Date` objects here (unlike `promo-code-config.entity.ts`'s
 * `rewardValue`, this table has no `decimal` column to lose precision on) — `dto/
 * campaign-promo-config.response.dto.ts` is the one place that turns them into wire-format ISO
 * strings, so this file stays the single "what does a row actually look like" source of truth.
 */

export type BindLevel = 'CAMPAIGN' | 'TRACKER' | 'COMPONENT';
export type CampaignPromoConfigStatus = 'ACTIVE' | 'INACTIVE';

/** Raw `promo_code.campaign_promo_config` row shape, snake_case, exactly as Postgres returns it. */
export interface CampaignPromoConfigRow {
  id: string;
  promo_code_config_id: string;
  tenant_id: string;
  bind_level: BindLevel;
  bind_ref_id: string;
  status: CampaignPromoConfigStatus;
  bound_by: string;
  bound_at: Date;
  updated_at: Date;
}

/** Domain shape — camelCase, the only shape any layer above the repository ever sees. */
export interface CampaignPromoConfig {
  id: string;
  promoCodeConfigId: string;
  tenantId: string;
  bindLevel: BindLevel;
  bindRefId: string;
  status: CampaignPromoConfigStatus;
  boundBy: string;
  boundAt: Date;
  updatedAt: Date;
}

export function toDomain(row: CampaignPromoConfigRow): CampaignPromoConfig {
  return {
    id: row.id,
    promoCodeConfigId: row.promo_code_config_id,
    tenantId: row.tenant_id,
    bindLevel: row.bind_level,
    bindRefId: row.bind_ref_id,
    status: row.status,
    boundBy: row.bound_by,
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
  };
}
