/**
 * T-032 — constants shared by the DTOs, the service and the tests. The reward equivalent of
 * `rules.constants.ts` (T-031).
 *
 * Column widths are transcribed from `reward_config.reward_systems`
 * (`system_code varchar(50)`, `name varchar(200)`, `description varchar(500)`,
 * `reward_type varchar(30)`, `delivery_mode varchar(20)`, `connector_type varchar(20)`,
 * `status varchar(20)`) and `reward_policies` (`policy_code varchar(80)`, `name varchar(200)`,
 * `description varchar(500)`) — see `database/reward_config_postgres.sql`.
 */

/** `role_entity_permissions.entity` for reward authoring (01-DATABASE.md §5.1, T004_001 seed). */
export const REWARD_ENTITY = 'reward';

/** `role_entity_permissions.entity` for country assignment writes/reads. */
export const REWARD_ASSIGNMENT_ENTITY = 'reward_assignment';

/**
 * T-116 — `role_entity_permissions.entity` for `reward_category`/`reward_sub_category` writes
 * (`T116_002`'s seed). `view` is available to every role via `@Roles(...ALL_PORTAL_ROLES)` on
 * `RewardCategoriesController`, matching `rules.constants.ts`'s own `RULE_CATEGORY_ENTITY`/
 * `RULE_SUB_CATEGORY_ENTITY` precedent (T-106).
 */
export const REWARD_CATEGORY_ENTITY = 'reward_category';
export const REWARD_SUB_CATEGORY_ENTITY = 'reward_sub_category';

export const REWARD_CATEGORY_CODE_MAX_LENGTH = 50;
export const REWARD_CATEGORY_NAME_MAX_LENGTH = 200;
export const REWARD_CATEGORY_DESCRIPTION_MAX_LENGTH = 500;

export const REWARD_SYSTEM_CODE_MAX_LENGTH = 50;
export const REWARD_NAME_MAX_LENGTH = 200;
export const REWARD_DESCRIPTION_MAX_LENGTH = 500;
export const REWARD_TYPE_MAX_LENGTH = 30;

/** `reward_systems.status` — the portal only ever writes these two (no live CHECK constraint on
 * this column, unlike `rule_master.status`'s `ck_rm_status`). */
export const REWARD_STATUSES = ['active', 'inactive'] as const;
export type RewardStatusValue = (typeof REWARD_STATUSES)[number];

export const REWARD_DELIVERY_MODES = ['realtime', 'batch', 'csv_export', 'scheduled'] as const;
export type RewardDeliveryModeValue = (typeof REWARD_DELIVERY_MODES)[number];

export const REWARD_CONNECTOR_TYPES = ['internal_api', 'file_export', 'webhook', 'manual'] as const;
export type RewardConnectorTypeValue = (typeof REWARD_CONNECTOR_TYPES)[number];

/**
 * `system_code` must be an upper-snake-case business key — matches `RULE_CODE_PATTERN`'s
 * reasoning in `rules.constants.ts`: every other "code" column in this schema is upper-snake in
 * the seeded reference data.
 */
export const REWARD_SYSTEM_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,49}$/;

export const REWARD_POLICY_CODE_MAX_LENGTH = 80;
export const REWARD_POLICY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,79}$/;

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — "`pageSize` capped at 100". */
export const MAX_PAGE_SIZE = 100;

/** `connector_config` request-body bound (implementation note 4) — mirrors
 * `packages/shared/src/reward.schema.ts`'s `REWARD_CONNECTOR_CONFIG_MAX_KEYS`, kept as a second,
 * server-side constant rather than imported, the same way `rules.constants.ts`'s
 * `RULE_PARAMETER_TYPES` duplicates (rather than imports) the shared enum — see that file's own
 * precedent; the shared schema is still what actually validates the value via
 * `rewards.validators.ts`. */
export const REWARD_CONNECTOR_CONFIG_MAX_KEYS = 30;

/**
 * `reward_campaign_assignments.status` values this module treats as "an active assignment", and
 * `tenant_campaigns.status` values treated as "an active campaign" — for the unassign-in-use
 * check (implementation note 7-equivalent for rewards, TC-9). Narrowed to the literal word the
 * task's own TC-9 uses ("active campaign"), the same choice `rules.constants.ts`'s
 * `ACTIVE_CAMPAIGN_STATUSES` documents and for the same reason: T-037 (campaign wizard) owns the
 * full campaign lifecycle and had not shipped at the time this was written.
 */
export const ACTIVE_CAMPAIGN_STATUSES = ['active'] as const;
