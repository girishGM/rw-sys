/**
 * T-032 — the response bodies `/rewards` returns, and the only shapes it may return.
 *
 * Built by hand from the `RewardSystem`/`RewardCountryAssignment`/`Country` model instances the
 * service loads, never by spreading a Sequelize row — the same construction rule
 * `rule-response.dto.ts`/`country-response.dto.ts` record, for the same reason. Mirrored
 * field-for-field by `packages/shared/src/reward.schema.ts`.
 *
 * `connector_config`'s three different shapes (absent / masked / write-only plaintext) are
 * exactly the split `reward.schema.ts`'s own header documents; this file is where "masked" is
 * actually built — see {@link maskConnectorConfigValue}.
 */
import type { Country } from '@/database/models/country.model';
import type { RewardCategory } from '@/database/models/reward-category.model';
import type { RewardCountryAssignment } from '@/database/models/reward-country-assignment.model';
import type { RewardSubCategory } from '@/database/models/reward-sub-category.model';
import type { RewardSystem } from '@/database/models/reward-system.model';
import type {
  RewardConnectorTypeValue,
  RewardDeliveryModeValue,
  RewardStatusValue,
} from '../rewards.constants';

/** A reward system with its category (and, when set, sub-category) eagerly loaded — T-118, the
 * shape every read path in this module loads it in so `toRewardDto`/`toRewardListItemDto` never
 * have to guard against a missing association. Mirrors `RuleWithCategory`
 * (`rule-response.dto.ts`), except `category` is a direct FK here rather than derived through
 * the sub-category — see `reward-system.model.ts`'s own header for why. */
export type RewardWithCategory = RewardSystem & {
  category: RewardCategory;
  subCategory: RewardSubCategory | null;
};

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent
 * `rule-response.dto.ts`'s own copy documents: this envelope is an API-wide convention no task
 * owns a shared home for. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

export interface ListMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface DataListEnvelope<T> {
  readonly data: readonly T[];
  readonly meta: ListMeta;
}

interface RewardCommonDto {
  readonly id: number;
  readonly systemCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly rewardType: string;
  readonly deliveryMode: RewardDeliveryModeValue;
  readonly connectorType: RewardConnectorTypeValue;
  readonly maintenanceWindowEnabled: boolean;
  readonly maintenanceSchedule: Record<string, unknown>;
  readonly retryEnabled: boolean;
  readonly retryConfig: Record<string, unknown>;
  readonly merchantId: number | null;
  /** T-118 — resolved from the eagerly-loaded `category`/`subCategory` associations, never a
   * bare id alone (mirrors `RuleDto`'s own `categoryName`/`subCategoryName`). */
  readonly categoryId: number;
  readonly categoryName: string;
  readonly subCategoryId: number | null;
  readonly subCategoryName: string | null;
  readonly status: RewardStatusValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `GET /rewards` (list) — no `connectorConfig`/`connectorConfigPreview` key at all (TC-11). */
export type RewardListItemDto = RewardCommonDto;

/**
 * `GET /rewards/:id` (detail) — `connectorConfigPreview` present but masked (TC-12), `null` when
 * unset. Named `connectorConfigPreview`, deliberately not `connectorConfig`: `ResponseMasking
 * Interceptor` (T-017) resolves an unannotated response field by bare key name across the whole
 * payload, and the seeded `reward_config.reward_versions.connector_config` policy row
 * (`T017_002_seed_policies.ts`) shares that bare name — naming this field `connectorConfig` would
 * have the interceptor mask it a *second* time (`maskDeep`'s `'full'` strategy over every scalar
 * leaf), destroying this module's own last-4-characters mask. Caught live by this module's own
 * e2e suite (TC-12/TC-13 both failed exactly this way before the rename); see `packages/shared/
 * src/reward.schema.ts`'s header for the full reasoning.
 */
export interface RewardDto extends RewardCommonDto {
  readonly connectorConfigPreview: Record<string, string> | null;
}

function commonFields(reward: RewardWithCategory): RewardCommonDto {
  return {
    id: reward.id,
    systemCode: reward.systemCode,
    name: reward.name,
    description: reward.description,
    rewardType: reward.rewardType,
    deliveryMode: reward.deliveryMode as RewardDeliveryModeValue,
    connectorType: reward.connectorType as RewardConnectorTypeValue,
    maintenanceWindowEnabled: reward.maintenanceWindowEnabled,
    maintenanceSchedule: reward.maintenanceSchedule,
    retryEnabled: reward.retryEnabled,
    retryConfig: reward.retryConfig,
    merchantId: reward.merchantId,
    categoryId: reward.category.id,
    categoryName: reward.category.name,
    subCategoryId: reward.subCategory === null ? null : reward.subCategory.id,
    subCategoryName: reward.subCategory === null ? null : reward.subCategory.name,
    status: reward.status as RewardStatusValue,
    createdAt: reward.createdAt.toISOString(),
    updatedAt: reward.updatedAt.toISOString(),
  };
}

export function toRewardListItemDto(reward: RewardWithCategory): RewardListItemDto {
  return commonFields(reward);
}

/**
 * `decryptedConnectorConfig` is `null` for "no connector config set" *and* for "could not be
 * decrypted" (`RewardConnectorConfigCrypto.decryptForRow`'s own contract) — both render the same
 * way here, `connectorConfig: null`, because neither is a case the caller can act on.
 */
export function toRewardDto(
  reward: RewardWithCategory,
  decryptedConnectorConfig: Record<string, unknown> | null,
): RewardDto {
  return {
    ...commonFields(reward),
    connectorConfigPreview:
      decryptedConnectorConfig === null ? null : maskConnectorConfig(decryptedConnectorConfig),
  };
}

/**
 * Masks every value in a decrypted `connectorConfig` object — `{"apiKey": "sk_live_1234"} →
 * {"apiKey": "••••1234"}` (implementation note 4's own example). Keys are never masked, only
 * values, since a key name (`apiKey`, `webhookSecret`) is metadata about the *shape* of the
 * config, not a credential itself.
 */
export function maskConnectorConfig(config: Record<string, unknown>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    masked[key] = maskConnectorConfigValue(value);
  }
  return masked;
}

const VISIBLE_SUFFIX_LENGTH = 4;
const MASK_CHAR = '•';

/**
 * A single value's mask. Strings keep their last four characters visible (implementation note
 * 4's own example, `"••••1234"`) unless they are four characters or shorter, in which case
 * nothing is shown at all — a 3-character value is not meaningfully protected by revealing 3 of
 * its 4 characters. Non-string values (numbers, booleans, nested objects) carry no meaningful
 * "last four characters", so they are masked in full.
 */
function maskConnectorConfigValue(value: unknown): string {
  if (typeof value === 'string' && value.length > VISIBLE_SUFFIX_LENGTH) {
    const suffix = value.slice(-VISIBLE_SUFFIX_LENGTH);
    return MASK_CHAR.repeat(VISIBLE_SUFFIX_LENGTH) + suffix;
  }
  return MASK_CHAR.repeat(VISIBLE_SUFFIX_LENGTH);
}

export interface RewardCountryAssignmentDto {
  readonly id: number;
  readonly rewardId: number;
  readonly countryId: number;
  readonly countryCode: string;
  readonly countryName: string;
  readonly assignedAt: string;
  readonly assignedBy: number | null;
}

export function toRewardCountryAssignmentDto(
  assignment: RewardCountryAssignment & { country: Country },
): RewardCountryAssignmentDto {
  return {
    id: assignment.id,
    rewardId: assignment.rewardId,
    countryId: assignment.countryId,
    countryCode: assignment.country.code,
    countryName: assignment.country.name,
    assignedAt: assignment.assignedAt.toISOString(),
    assignedBy: assignment.assignedBy,
  };
}
