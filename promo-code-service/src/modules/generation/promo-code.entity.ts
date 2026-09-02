/**
 * T-PC-021. `promo_code.promo_code` — the issuance ledger (`01-DATABASE.md` §3, migration
 * `004_create_promo_code.ts`). Same row-shape/domain-shape split as `promo-code-config.entity.ts`
 * (T-PC-010)/`campaign-promo-config.entity.ts` (T-PC-012): raw snake_case straight off Postgres
 * vs. the camelCase shape every layer above the repository actually works with.
 *
 * `rewardValue` stays a `string` end to end, same reasoning as `promo-code-config.entity.ts`'s own
 * header: Postgres `decimal(18,4)` comes back from `pg` as a string, and re-parsing to a JS
 * `number` risks silent precision loss on a money value.
 *
 * `rewardValueType`/`rewardValue`/`rewardUnit` here are a **snapshot** copied from the resolved
 * `promo_code_config` at generation time (implementation note 6) — this entity has no join back to
 * that table, deliberately, so a later config edit can never retroactively change what an
 * already-issued code pays out.
 */

export type PromoCodeStatus = 'ISSUED' | 'REDEEMED' | 'EXPIRED' | 'CANCELLED';

/** Raw `promo_code.promo_code` row shape, snake_case, exactly as Postgres returns it. */
export interface PromoCodeRow {
  id: string;
  promo_code_config_id: string;
  campaign_promo_config_id: string | null;
  code: string;
  customer_id: string;
  tenant_id: string;
  merchant_id: string | null;
  reward_value_type: string;
  reward_value: string;
  reward_unit: string;
  status: PromoCodeStatus;
  correlation_id: string;
  // T-PC-056: widened to add 'REST' — append-only (R8), matching
  // `generation-request.types.ts`'s own `TRANSPORTS` widen for the same task.
  transport: 'KAFKA' | 'GRPC' | 'REST';
  issued_at: Date;
  expires_at: Date | null;
  redeemed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Domain shape — camelCase, the only shape any layer above the repository ever sees. */
export interface PromoCode {
  id: string;
  promoCodeConfigId: string;
  campaignPromoConfigId: string | null;
  code: string;
  customerId: string;
  tenantId: string;
  merchantId: string | null;
  rewardValueType: string;
  rewardValue: string;
  rewardUnit: string;
  status: PromoCodeStatus;
  correlationId: string;
  // T-PC-056: widened to add 'REST' — append-only (R8), matching
  // `generation-request.types.ts`'s own `TRANSPORTS` widen for the same task.
  transport: 'KAFKA' | 'GRPC' | 'REST';
  issuedAt: Date;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toDomain(row: PromoCodeRow): PromoCode {
  return {
    id: row.id,
    promoCodeConfigId: row.promo_code_config_id,
    campaignPromoConfigId: row.campaign_promo_config_id,
    code: row.code,
    customerId: row.customer_id,
    tenantId: row.tenant_id,
    merchantId: row.merchant_id,
    rewardValueType: row.reward_value_type,
    rewardValue: row.reward_value,
    rewardUnit: row.reward_unit,
    status: row.status,
    correlationId: row.correlation_id,
    transport: row.transport,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
