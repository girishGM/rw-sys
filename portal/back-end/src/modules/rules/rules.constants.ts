/**
 * T-031 — constants shared by the DTOs, the service and the tests.
 *
 * Column widths are transcribed from `reward_config.rule_master`
 * (`rule_code varchar(80)`, `name varchar(200)`, `expression text`, `parameters text`,
 * `status varchar(20) check (status in ('active','inactive'))`) — see
 * `REWARDCONFIG-schema-DDL-extracted-from-reward-system-seedsql.md` §A "rule_master", and
 * `rule_country_assignments` (no width limits beyond the integer FKs).
 */

/** `role_entity_permissions.entity` for rule authoring (01-DATABASE.md §5.1, T004_001 seed). */
export const RULE_ENTITY = 'rule';

/** `role_entity_permissions.entity` for country assignment writes/reads. */
export const RULE_ASSIGNMENT_ENTITY = 'rule_assignment';

export const RULE_CODE_MAX_LENGTH = 80;
export const RULE_NAME_MAX_LENGTH = 200;
export const RULE_EXPRESSION_MAX_LENGTH = 8000;

/** `ck_rm_status` (live constraint, `rule_master.status`). */
export const RULE_STATUSES = ['active', 'inactive'] as const;
export type RuleStatusValue = (typeof RULE_STATUSES)[number];

/**
 * `rule_code` must be an upper-snake-case business key — no spaces, no punctuation beyond
 * `_`. Chosen to match every other "code" column in this schema (`countryCode`,
 * `campaignCode`, `componentCode`), which are all upper-snake in the seeded reference data.
 */
export const RULE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,79}$/;

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — "`pageSize` capped at 100". */
export const MAX_PAGE_SIZE = 100;

/**
 * `rule_master.parameters` meta-schema bounds (implementation note 4 — "validate it against a
 * meta-schema on save").
 */
export const RULE_PARAMETERS_MAX_FIELDS = 50;
export const RULE_PARAMETER_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export const RULE_PARAMETER_TYPES = ['string', 'number', 'boolean', 'date', 'select'] as const;
export type RuleParameterType = (typeof RULE_PARAMETER_TYPES)[number];

/**
 * `tenant_campaigns.status` values this module treats as "an active campaign" for the
 * unassign-in-use check (implementation note 6, TC-12). T-037 (the campaign wizard, not yet
 * built at the time this module was written) owns the full campaign status lifecycle;
 * narrowed here to the one value the task's own test case names literally ("used by an
 * **active** campaign") rather than guessing at a lifecycle this module does not own. See
 * `campaign-usage.query.ts`'s header for the escalation this narrowing is flagged under.
 */
export const ACTIVE_CAMPAIGN_STATUSES = ['active'] as const;
