/**
 * T-PC-010. `promo_code.promo_code_config` — the reusable recipe a Maker picks by name
 * (01-DATABASE.md §1). This project's migrations are raw SQL (ARCHITECTURE.md §4), not
 * `sequelize-typescript` `@Table` models — the repository (`promo-code-config.repository.ts`)
 * talks to Postgres with parameterised `sequelize.query(...)` calls, the same convention
 * `test/database/migrations.spec.ts` already established for this schema. This file is the
 * shape boundary between that raw row and the domain object every other layer (service,
 * REST controller in T-PC-011, bind API in T-PC-012) actually works with.
 *
 * **T-PC-058 update**: migration `T-PC-058_001_split_promo_code_config_version.ts` moved every
 * code-generation/payout column (`code_prefix`/.../`code_expiry_days`) off this table onto the new
 * `promo_code_config_version` table (`promo-code-config-version.entity.ts`) — this row is now the
 * *enduring identity* only (tenant, merchant, name, status), never the payout itself. `CharacterSet`/
 * `RewardValueType` stay defined and exported **from this file** even though this table no longer
 * carries either column directly — `src/modules/generation/promo-code.repository.ts` (a different
 * task's exclusive scope, R8) imports both by name from here
 * (`import type { CharacterSet, RewardValueType } from '../promo-code-config/promo-code-config.entity'`)
 * and that import must keep resolving; moving them to `promo-code-config-version.entity.ts` instead
 * would silently break a file this task is not allowed to edit.
 *
 * `rewardValue` (now on `PromoCodeConfigVersion`, not here) is still kept as a `string`, not a
 * `number`, end to end (row → domain) — Postgres `decimal(18,4)` comes back from `pg` as a string
 * by default, and re-parsing it to a JS `number` risks silent precision loss on a money value.
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
    status: row.status,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
