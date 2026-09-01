/**
 * T-PC-010. `promo_code.promo_code_config` — the reusable recipe a Maker picks by name
 * (01-DATABASE.md §1). This project's migrations are raw SQL (ARCHITECTURE.md §4), not
 * `sequelize-typescript` `@Table` models — the repository (`promo-code-config.repository.ts`)
 * talks to Postgres with parameterised `sequelize.query(...)` calls, the same convention
 * `test/database/migrations.spec.ts` already established for this schema. This file is the
 * shape boundary between that raw row and the domain object every other layer (service,
 * REST controller in T-PC-011, bind API in T-PC-012) actually works with.
 *
 * `rewardValue` is kept as a `string`, not a `number`, end to end (row → domain). Postgres
 * `decimal(18,4)` comes back from `pg` as a string by default (no custom type parser
 * registered anywhere in this service), and re-parsing it to a JS `number` risks silent
 * precision loss on a money value — `04-API-CONTRACT.md` §1's own example response shows
 * `"rewardValue": "10.0000"` as a string for exactly this reason.
 */

export type PromoCodeConfigStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type CharacterSet = 'NUMERIC' | 'ALPHA' | 'ALPHANUMERIC';
export type RewardValueType = 'FIXED_AMOUNT' | 'PERCENTAGE' | 'POINTS';

/** Raw `promo_code.promo_code_config` row shape, snake_case, exactly as Postgres returns it. */
export interface PromoCodeConfigRow {
  id: string;
  tenant_id: string;
  merchant_id: string | null;
  name: string;
  code_prefix: string | null;
  code_postfix: string | null;
  code_length: number;
  character_set: CharacterSet;
  exclude_ambiguous_chars: boolean;
  reward_value_type: RewardValueType;
  reward_value: string;
  reward_unit: string;
  max_redemptions_per_code: number;
  code_expiry_days: number | null;
  status: PromoCodeConfigStatus;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** Domain shape — camelCase, the only shape any layer above the repository ever sees. */
export interface PromoCodeConfig {
  id: string;
  tenantId: string;
  merchantId: string | null;
  name: string;
  codePrefix: string | null;
  codePostfix: string | null;
  codeLength: number;
  characterSet: CharacterSet;
  excludeAmbiguousChars: boolean;
  rewardValueType: RewardValueType;
  rewardValue: string;
  rewardUnit: string;
  maxRedemptionsPerCode: number;
  codeExpiryDays: number | null;
  status: PromoCodeConfigStatus;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toDomain(row: PromoCodeConfigRow): PromoCodeConfig {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    merchantId: row.merchant_id,
    name: row.name,
    codePrefix: row.code_prefix,
    codePostfix: row.code_postfix,
    codeLength: row.code_length,
    characterSet: row.character_set,
    excludeAmbiguousChars: row.exclude_ambiguous_chars,
    rewardValueType: row.reward_value_type,
    rewardValue: row.reward_value,
    rewardUnit: row.reward_unit,
    maxRedemptionsPerCode: row.max_redemptions_per_code,
    codeExpiryDays: row.code_expiry_days,
    status: row.status,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
