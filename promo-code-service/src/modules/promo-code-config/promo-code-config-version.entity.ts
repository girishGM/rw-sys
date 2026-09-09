/**
 * T-PC-058. `promo_code.promo_code_config_version` — the versioned, payout-defining half of what
 * used to be a single `promo_code_config` row (migration `T-PC-058_001_split_promo_code_config_
 * version.ts`, T-PC-059). Every code-generation/payout column that used to live directly on
 * `promo_code_config` now lives here instead: `code_prefix`/`code_postfix`/`code_length`/
 * `character_set`/`exclude_ambiguous_chars`/`reward_value_type`/`reward_value`/`reward_unit`/
 * `max_redemptions_per_code`/`code_expiry_days`, plus the version lifecycle itself (`version_no`,
 * `status`, `supersedes_version_id`, publish/deprecate/retire timestamps).
 *
 * Same row-shape/domain-shape split as `promo-code-config.entity.ts` (T-PC-010) — raw snake_case
 * straight off Postgres vs. the camelCase shape every layer above the repository actually works
 * with. Deliberately a distinct type from `src/modules/generation/promo-code.repository.ts`'s own
 * `PromoCodeConfigVersion` (that module's exclusive scope, R8) — that one only carries the subset
 * `PromoCodeGenerationService` needs to resolve and stamp a version at generation time; this one is
 * the full admin-CRUD-facing shape (`max_redemptions_per_code`, `supersedes_version_id`,
 * `created_by`/`created_at`, all four lifecycle timestamps) this module's own service/controller
 * need to drive the draft → published → deprecated/retired lifecycle.
 */
import type { CharacterSet, RewardValueType } from './promo-code-config.entity';

export type PromoCodeConfigVersionStatus = 'draft' | 'published' | 'deprecated' | 'retired';

/** Raw `promo_code.promo_code_config_version` row shape, snake_case, exactly as Postgres returns it. */
export interface PromoCodeConfigVersionRow {
  id: string;
  promo_code_config_id: string;
  version_no: number;
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
  status: PromoCodeConfigVersionStatus;
  supersedes_version_id: string | null;
  created_by: string;
  created_at: Date;
  published_by: string | null;
  published_at: Date | null;
  deprecated_at: Date | null;
  retired_at: Date | null;
  updated_at: Date;
}

/** Domain shape — camelCase, the only shape any layer above the repository ever sees. */
export interface PromoCodeConfigVersion {
  id: string;
  promoCodeConfigId: string;
  versionNo: number;
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
  status: PromoCodeConfigVersionStatus;
  supersedesVersionId: string | null;
  createdBy: string;
  createdAt: Date;
  publishedBy: string | null;
  publishedAt: Date | null;
  deprecatedAt: Date | null;
  retiredAt: Date | null;
  updatedAt: Date;
}

export function toDomain(row: PromoCodeConfigVersionRow): PromoCodeConfigVersion {
  return {
    id: row.id,
    promoCodeConfigId: row.promo_code_config_id,
    versionNo: row.version_no,
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
    supersedesVersionId: row.supersedes_version_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
    deprecatedAt: row.deprecated_at,
    retiredAt: row.retired_at,
    updatedAt: row.updated_at,
  };
}
