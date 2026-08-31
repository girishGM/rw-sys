/**
 * T-032 — the wire contract of `/rewards`, shared by the back end that produces it and the SPA
 * that consumes it (00-ARCHITECTURE.md §8: "One Zod schema shared with the back end via
 * `packages/shared` → identical client and server validation"). The reward equivalent of
 * `rule.schema.ts` (T-031) — same discipline: bytes on the wire only, `.strict()` everywhere, no
 * defaults the server never sent, no coercion.
 *
 * ### `connector_config` is not one shape on the wire — it is three
 *
 * `reward_systems.connector_config` may hold third-party credentials (implementation note 4),
 * so it never appears on the wire as the plain object a caller submits:
 *
 *  - **Write** (`rewardConnectorConfigSchema`, wire field `connectorConfig`) — what
 *    `POST`/`PATCH /rewards` accepts. Bounded (at most {@link REWARD_CONNECTOR_CONFIG_MAX_KEYS}
 *    keys) so a single request cannot grow an unbounded ciphertext blob.
 *  - **List** — absent entirely (`rewardListItemSchema` has no `connectorConfig`/
 *    `connectorConfigPreview` key at all). Never present, never `null` — the key itself does not
 *    exist, matching TC-11.
 *  - **Detail** (`maskedRewardConnectorConfigSchema`, wire field **`connectorConfigPreview`**,
 *    deliberately not `connectorConfig`) — every value replaced by a mask
 *    (`{"apiKey": "••••1234"}`); the ciphertext and the plaintext both stay server-side.
 *
 * The three are deliberately different schemas rather than one made optional/nullable, so a
 * server bug that accidentally returns the write shape on a detail read (i.e. leaks plaintext)
 * fails the contract test rather than silently validating.
 *
 * ### Why the detail field is named `connectorConfigPreview`, not `connectorConfig`
 *
 * `ResponseMaskingInterceptor` (T-017) resolves a policy for an *unannotated* response field by
 * its **bare key name** across the whole payload (`response-masking.interceptor.ts`'s own "alias
 * rule": *"a response DTO carries `email`, not `reward_portal.portal_users.email`"*), and
 * `T017_002_seed_policies.ts` already seeds a row keyed `reward_config.reward_versions.
 * connector_config` with `uiVisibility: 'masked'`, `maskStrategy: null` (→ `maskDeep`'s `'full'`
 * default). Because that row's *bare* field name is also `connectorConfig`, a detail response
 * naming this field `connectorConfig` collides with it: the interceptor masks *every scalar leaf
 * a second time*, turning this module's own `{"apiKey": "••••1234"}` into `{"apiKey":
 * "••••••••"}` — a real bug this file's own e2e suite caught (TC-12/TC-13 initially failed
 * exactly this way). `connectorConfigPreview` shares no bare name with any seeded policy row, so
 * it passes through the interceptor unmodified — this module's own masking (`reward-response.
 * dto.ts#maskConnectorConfig`) is the only masking that ever touches it, which is the layer this
 * task actually owns and tests. Not a design doc conflict: 07-DATA-PROTECTION.md never names
 * `reward_systems.connector_config`'s wire field at all, so no wire-contract commitment is broken
 * by choosing a collision-free name for it.
 */
import { z } from 'zod';

/** `reward_config.reward_systems.status` — same vocabulary as `rule_master.status` (`ck_rm_status`
 * doesn't apply here; `reward_systems` has no CHECK constraint, but the portal only ever writes
 * these two values, matching implementation note 7's "status='inactive' hides it"). */
export const REWARD_STATUSES = ['active', 'inactive'] as const;
export const rewardStatusSchema = z.enum(REWARD_STATUSES);
export type RewardStatus = z.infer<typeof rewardStatusSchema>;

/**
 * `reward_systems.delivery_mode` — a constrained vocabulary (implementation note 6), grounded in
 * the three values already live in `reward_config.reward_systems` (`realtime`, `batch`,
 * `csv_export`) plus `scheduled` for a time-windowed variant neither legacy row uses yet.
 */
export const REWARD_DELIVERY_MODES = ['realtime', 'batch', 'csv_export', 'scheduled'] as const;
export const rewardDeliveryModeSchema = z.enum(REWARD_DELIVERY_MODES);
export type RewardDeliveryMode = z.infer<typeof rewardDeliveryModeSchema>;

/**
 * `reward_systems.connector_type` — a constrained vocabulary (implementation note 6), grounded in
 * the two values already live (`internal_api`, `file_export`) plus `webhook`/`manual` for
 * connector shapes no legacy row uses yet. This is the **write** schema — `POST`/`PATCH /rewards`
 * reject anything outside it, satisfying implementation note 6 to the letter ("validate against
 * explicit enums... not free text").
 */
export const REWARD_CONNECTOR_TYPES = ['internal_api', 'file_export', 'webhook', 'manual'] as const;
export const rewardConnectorTypeSchema = z.enum(REWARD_CONNECTOR_TYPES);
export type RewardConnectorType = z.infer<typeof rewardConnectorTypeSchema>;

/**
 * T-158 — the **read** shape for `connector_type`, deliberately looser than
 * {@link rewardConnectorTypeSchema}. `reward_config.reward_systems.connector_type` has no CHECK
 * constraint (`varchar(20)`, same as `reward_type` — see {@link rewardTypeSchema}'s own note on
 * that column), and rows written outside `POST /rewards` (this dev DB's own e2e fixture leftovers,
 * confirmed directly: 16 `reward_systems` rows carry `connector_type = 'internal'`, a pre-rename
 * value the current enum no longer includes) genuinely exist. Before this change,
 * `rewardListItemSchema`/`rewardSchema` used the strict enum on read too, so **one** such row
 * anywhere in a caller's scope failed `.safeParse` for the *entire* list — reproduced live
 * (T-158): a `super_admin`'s unscoped `GET /rewards` includes every legacy row, so the whole page
 * rendered the generic `UNKNOWN_ERROR_MESSAGE` while a narrower-scoped `country_admin`, whose one
 * visible reward happened to carry a valid value, saw no error at all. A write path that only
 * ever accepts the closed enum (`createRewardRequestSchema`/`updateRewardRequestSchema`, both
 * unchanged) cannot produce this value going forward; a read path must still tolerate whatever is
 * already stored, exactly the same asymmetry {@link rewardTypeSchema} already documents for its
 * sibling column. Bounded to the column's own width so a legacy value still cannot carry an
 * unbounded blob.
 */
export const rewardConnectorTypeReadSchema = z.string().min(1).max(20);

/**
 * `reward_systems.reward_type` is deliberately **not** a closed enum, unlike `delivery_mode`/
 * `connector_type` above — 11-BUDGETS-AND-LIMITS.md §3.1 is explicit: *"`reward_systems.
 * reward_type` is free text with no CHECK and legacy rows exist, so the portal does not
 * constrain it retrospectively."* That is a direct conflict with this task's own implementation
 * note 6 ("`reward_type` ... are constrained vocabularies"); the design doc wins (AGENT-PROTOCOL
 * §3) and the conflict is flagged in the completion report. Still bounded in length/shape so it
 * cannot carry control characters or an unbounded blob.
 */
export const rewardTypeSchema = z.string().min(1).max(30);

/** At most this many keys in one `connector_config` submission — a request body bound, not a
 * business rule; the real bound on what gets stored is the encrypted column's own width. */
export const REWARD_CONNECTOR_CONFIG_MAX_KEYS = 30;

const rewardConnectorConfigValueSchema = z.union([z.string().max(4000), z.number(), z.boolean()]);

/** The shape `POST`/`PATCH /rewards` accepts for `connectorConfig` — plaintext, client → server
 * only, over TLS (and payload-encrypted per 07-DATA-PROTECTION.md §5's `fields` mode). Encrypted
 * at rest before it ever reaches a column (implementation note 4). */
export const rewardConnectorConfigSchema = z
  .record(z.string().min(1).max(100), rewardConnectorConfigValueSchema)
  .refine((value) => Object.keys(value).length <= REWARD_CONNECTOR_CONFIG_MAX_KEYS, {
    message: `connectorConfig may hold at most ${String(REWARD_CONNECTOR_CONFIG_MAX_KEYS)} keys`,
  });

export type RewardConnectorConfig = z.infer<typeof rewardConnectorConfigSchema>;

/** The masked shape `GET /rewards/:id` returns for `connectorConfig` — every value is a mask
 * string (`"••••1234"`), never the plaintext or the ciphertext. `null` when no connector config
 * has been set. */
export const maskedRewardConnectorConfigSchema = z.record(z.string(), z.string()).nullable();

export type MaskedRewardConnectorConfig = z.infer<typeof maskedRewardConnectorConfigSchema>;

/** `maintenance_schedule` / `retry_config` — plain JSON, never secret (unlike `connector_config`),
 * so it round-trips as-is on every response. */
const jsonObjectSchema = z.record(z.string(), z.unknown());

/** Fields common to every `/rewards` response row — everything except `connectorConfig`, whose
 * shape differs between a list row (absent) and a detail row (masked). */
const rewardCommonFields = {
  id: z.number().int(),
  systemCode: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  rewardType: rewardTypeSchema,
  deliveryMode: rewardDeliveryModeSchema,
  // T-158 — the read schema, not the write one; see `rewardConnectorTypeReadSchema`'s own note.
  connectorType: rewardConnectorTypeReadSchema,
  maintenanceWindowEnabled: z.boolean(),
  maintenanceSchedule: jsonObjectSchema,
  retryEnabled: z.boolean(),
  retryConfig: jsonObjectSchema,
  merchantId: z.number().int().nullable(),
  /** T-118 — resolved category/sub-category, same shape `rule.schema.ts#ruleSchema` gives
   * `categoryId`/`categoryName`/`subCategoryId`/`subCategoryName`, except both may appear
   * without the other being `null` here: `subCategoryId` alone is genuinely optional (a reward
   * category may have zero sub-categories, T-116's own "Points never needs one" example). */
  categoryId: z.number().int(),
  categoryName: z.string(),
  subCategoryId: z.number().int().nullable(),
  subCategoryName: z.string().nullable(),
  status: rewardStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
};

/** One row of `GET /rewards` (list). No `connectorConfig` key at all (TC-11). */
export const rewardListItemSchema = z.object(rewardCommonFields).strict();
export type RewardListItem = z.infer<typeof rewardListItemSchema>;

/** `GET /rewards/:id` (detail). `connectorConfigPreview` is present but masked (TC-12) — named to
 * avoid colliding with the seeded `reward_versions.connector_config` policy row; see this file's
 * header. */
export const rewardSchema = z
  .object({ ...rewardCommonFields, connectorConfigPreview: maskedRewardConnectorConfigSchema })
  .strict();
export type Reward = z.infer<typeof rewardSchema>;

const listMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .strict();

export const rewardListEnvelopeSchema = z
  .object({ data: z.array(rewardListItemSchema), meta: listMetaSchema })
  .strict();

export const rewardEnvelopeSchema = z.object({ data: rewardSchema }).strict();

/** The request body of `POST /rewards`. `tenant_id` is never here (AGENT-PROTOCOL R3) — the
 * server always writes `NULL` for a global reward (01-DATABASE.md §4). */
export const createRewardRequestSchema = z
  .object({
    systemCode: z.string().min(2).max(50),
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    rewardType: rewardTypeSchema,
    deliveryMode: rewardDeliveryModeSchema.optional(),
    connectorType: rewardConnectorTypeSchema,
    connectorConfig: rewardConnectorConfigSchema.optional(),
    maintenanceWindowEnabled: z.boolean().optional(),
    maintenanceSchedule: jsonObjectSchema.optional(),
    retryEnabled: z.boolean().optional(),
    retryConfig: jsonObjectSchema.optional(),
    merchantId: z.number().int().optional(),
    // T-118 — `categoryId` is required (`reward_systems.category_id` is `NOT NULL`);
    // `subCategoryId` is optional, same "a category may have zero sub-categories" reasoning
    // `createRewardSubCategoryRequestSchema` documents below.
    categoryId: z.number().int(),
    subCategoryId: z.number().int().optional(),
  })
  .strict();

export type CreateRewardRequest = z.infer<typeof createRewardRequestSchema>;

/** The request body of `PATCH /rewards/:id`. `systemCode` is immutable, never here — and so,
 * since T-118, are `categoryId`/`subCategoryId` (immutable-by-replacement, the task's own scope
 * note): changing a reward's category is a new reward, not an edit to an existing one. */
export const updateRewardRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).nullable().optional(),
    rewardType: rewardTypeSchema.optional(),
    deliveryMode: rewardDeliveryModeSchema.optional(),
    connectorType: rewardConnectorTypeSchema.optional(),
    connectorConfig: rewardConnectorConfigSchema.optional(),
    maintenanceWindowEnabled: z.boolean().optional(),
    maintenanceSchedule: jsonObjectSchema.optional(),
    retryEnabled: z.boolean().optional(),
    retryConfig: jsonObjectSchema.optional(),
    merchantId: z.number().int().nullable().optional(),
    status: rewardStatusSchema.optional(),
  })
  .strict();

export type UpdateRewardRequest = z.infer<typeof updateRewardRequestSchema>;

/** One row of `GET /rewards/:id/countries` — a `reward_country_assignments` row, joined for
 * display. Mirrors `ruleCountryAssignmentSchema`. */
export const rewardCountryAssignmentSchema = z
  .object({
    id: z.number().int(),
    rewardId: z.number().int(),
    countryId: z.number().int(),
    countryCode: z.string(),
    countryName: z.string(),
    assignedAt: z.string(),
    assignedBy: z.number().int().nullable(),
  })
  .strict();

export type RewardCountryAssignment = z.infer<typeof rewardCountryAssignmentSchema>;

export const rewardCountryAssignmentListEnvelopeSchema = z
  .object({ data: z.array(rewardCountryAssignmentSchema) })
  .strict();

export const rewardCountryAssignmentEnvelopeSchema = z
  .object({ data: rewardCountryAssignmentSchema })
  .strict();

/** The request body of `POST /rewards/:id/countries`. `assignedBy` is never here — the service
 * writes it from `@CurrentUser()` (AGENT-PROTOCOL R3). */
export const assignRewardCountryRequestSchema = z.object({ countryId: z.number().int() }).strict();

export type AssignRewardCountryRequest = z.infer<typeof assignRewardCountryRequestSchema>;

// --- reward_policies (super_admin only, 03-API-CONTRACT.md §9) --------------------------------

export const REWARD_POLICY_STATUSES = ['active', 'inactive'] as const;
export const rewardPolicyStatusSchema = z.enum(REWARD_POLICY_STATUSES);

/** One row of `GET /rewards/:id/policies`. `config` is plain JSON — never secret. */
export const rewardPolicySchema = z
  .object({
    id: z.number().int(),
    rewardSystemId: z.number().int(),
    policyCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    config: jsonObjectSchema,
    status: rewardPolicyStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type RewardPolicy = z.infer<typeof rewardPolicySchema>;

export const rewardPolicyListEnvelopeSchema = z
  .object({ data: z.array(rewardPolicySchema) })
  .strict();

export const rewardPolicyEnvelopeSchema = z.object({ data: rewardPolicySchema }).strict();

/** The request body of `POST /rewards/:id/policies`. */
export const createRewardPolicyRequestSchema = z
  .object({
    policyCode: z.string().min(2).max(80),
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    config: jsonObjectSchema.optional(),
  })
  .strict();

export type CreateRewardPolicyRequest = z.infer<typeof createRewardPolicyRequestSchema>;

/** The request body of `PATCH /rewards/:id/policies/:policyId`. `policyCode` is immutable. */
export const updateRewardPolicyRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).nullable().optional(),
    config: jsonObjectSchema.optional(),
    status: rewardPolicyStatusSchema.optional(),
  })
  .strict();

export type UpdateRewardPolicyRequest = z.infer<typeof updateRewardPolicyRequestSchema>;

// --- reward_policy_caps (super_admin only, implementation note 5) -----------------------------

export const REWARD_POLICY_CAP_TYPES = [
  'per_customer',
  'per_campaign',
  'daily',
  'weekly',
  'monthly',
  'total',
] as const;
export const rewardPolicyCapTypeSchema = z.enum(REWARD_POLICY_CAP_TYPES);

export const REWARD_POLICY_CAP_FREQUENCY_UNITS = ['day', 'week', 'month'] as const;
export const rewardPolicyCapFrequencyUnitSchema = z.enum(REWARD_POLICY_CAP_FREQUENCY_UNITS);

export const REWARD_POLICY_CAP_STATUSES = ['active', 'inactive'] as const;
export const rewardPolicyCapStatusSchema = z.enum(REWARD_POLICY_CAP_STATUSES);

/** One row of `GET /rewards/:id/policies/:policyId/caps`. */
export const rewardPolicyCapSchema = z
  .object({
    id: z.number().int(),
    rewardPolicyId: z.number().int(),
    capType: rewardPolicyCapTypeSchema,
    frequencyValue: z.number().int().nullable(),
    frequencyUnit: rewardPolicyCapFrequencyUnitSchema.nullable(),
    maxOccurrences: z.number().int().nullable(),
    maxTotalAmount: z.number().nullable(),
    status: rewardPolicyCapStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type RewardPolicyCap = z.infer<typeof rewardPolicyCapSchema>;

export const rewardPolicyCapListEnvelopeSchema = z
  .object({ data: z.array(rewardPolicyCapSchema) })
  .strict();

export const rewardPolicyCapEnvelopeSchema = z.object({ data: rewardPolicyCapSchema }).strict();

export const createRewardPolicyCapRequestSchema = z
  .object({
    capType: rewardPolicyCapTypeSchema,
    frequencyValue: z.number().int().positive().optional(),
    frequencyUnit: rewardPolicyCapFrequencyUnitSchema.optional(),
    maxOccurrences: z.number().int().positive().optional(),
    maxTotalAmount: z.number().positive().optional(),
  })
  .strict();

export type CreateRewardPolicyCapRequest = z.infer<typeof createRewardPolicyCapRequestSchema>;

export const updateRewardPolicyCapRequestSchema = z
  .object({
    frequencyValue: z.number().int().positive().nullable().optional(),
    frequencyUnit: rewardPolicyCapFrequencyUnitSchema.nullable().optional(),
    maxOccurrences: z.number().int().positive().nullable().optional(),
    maxTotalAmount: z.number().positive().nullable().optional(),
    status: rewardPolicyCapStatusSchema.optional(),
  })
  .strict();

export type UpdateRewardPolicyCapRequest = z.infer<typeof updateRewardPolicyCapRequestSchema>;

// --- reward_categories / reward_sub_categories (T-116) -----------------------------------------
//
// The reward equivalent of `rule.schema.ts`'s own `ruleCategorySchema`/`ruleSubCategorySchema`
// family (T-106) — same shape, same `.strict()` discipline. A category may legitimately have
// zero sub-categories (this task's own scope note: e.g. Points never needs one); nothing here
// requires at least one.

/** `GET /reward-categories`. Read-only reference data, same shape `ruleCategorySchema`
 * declares. */
export const rewardCategorySchema = z
  .object({
    id: z.number().int(),
    categoryCode: z.string(),
    name: z.string(),
    status: z.string(),
  })
  .strict();

export type RewardCategory = z.infer<typeof rewardCategorySchema>;

export const rewardCategoryListEnvelopeSchema = z
  .object({ data: z.array(rewardCategorySchema) })
  .strict();

/** `GET /reward-sub-categories`. Read-only reference data, same shape
 * `ruleSubCategorySchema` declares. */
export const rewardSubCategorySchema = z
  .object({
    id: z.number().int(),
    categoryId: z.number().int(),
    subCategoryCode: z.string(),
    name: z.string(),
    status: z.string(),
  })
  .strict();

export type RewardSubCategory = z.infer<typeof rewardSubCategorySchema>;

export const rewardSubCategoryListEnvelopeSchema = z
  .object({ data: z.array(rewardSubCategorySchema) })
  .strict();

/** `POST /reward-categories`. `categoryCode` is immutable once created, same discipline
 * `createRewardRequestSchema` applies to `systemCode` — never in the update schema below. */
export const createRewardCategoryRequestSchema = z
  .object({
    categoryCode: z.string().min(2).max(50),
    name: z.string().min(1).max(200),
  })
  .strict();

export type CreateRewardCategoryRequest = z.infer<typeof createRewardCategoryRequestSchema>;

export const updateRewardCategoryRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: rewardStatusSchema.optional(),
  })
  .strict();

export type UpdateRewardCategoryRequest = z.infer<typeof updateRewardCategoryRequestSchema>;

export const rewardCategoryEnvelopeSchema = z.object({ data: rewardCategorySchema }).strict();

/** `POST /reward-sub-categories`. Moving a sub-category to a different category is out of
 * scope (T-116, matching T-106's own precedent) — `categoryId` is write-once, at creation, and
 * absent from the update schema. */
export const createRewardSubCategoryRequestSchema = z
  .object({
    categoryId: z.number().int(),
    subCategoryCode: z.string().min(2).max(50),
    name: z.string().min(1).max(200),
  })
  .strict();

export type CreateRewardSubCategoryRequest = z.infer<typeof createRewardSubCategoryRequestSchema>;

export const updateRewardSubCategoryRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: rewardStatusSchema.optional(),
  })
  .strict();

export type UpdateRewardSubCategoryRequest = z.infer<typeof updateRewardSubCategoryRequestSchema>;

export const rewardSubCategoryEnvelopeSchema = z.object({ data: rewardSubCategorySchema }).strict();

// --- reward version Kind + value config (T-119) -----------------------------------------------
//
// 13-REWARD-MASTER-VALUE-SOURCES.md §5: `reward_versions` gains a nullable `reward_kind` and a
// nullable `value_config` whose *shape depends on the kind* — the reward-side parallel of
// `rule_versions.resolver_id`/`resolver_config` (T-103). Modelled here, once, as a Zod
// discriminated union so the value schema is data-driven rather than a new frontend branch per
// kind (task objective), and so the server-side gate and the SPA's own editor (T-120) can never
// drift apart (00-ARCHITECTURE.md §8).
//
// These live in `reward.schema.ts` rather than `version.schema.ts` (where the rest of the
// reward-version wire contract lives) because that is the file T-119 owns; the two keys
// `version.schema.ts` needs import from here.

/** `reward_versions.reward_kind` — the closed vocabulary `ck_rewv_reward_kind` also enforces. */
export const REWARD_KINDS = [
  'FIXED_AMOUNT',
  'PERCENTAGE',
  'POINTS',
  'PHYSICAL',
  'PROMO_CODE',
] as const;
export const rewardKindSchema = z.enum(REWARD_KINDS);
export type RewardKind = z.infer<typeof rewardKindSchema>;

/** ISO-4217 alphabetic code. Which codes a tenant may actually use is `tenant_currencies`
 * (T-126, §4) — a database question this shared schema deliberately does not answer; all it
 * enforces is the shape a currency code has on the wire. */
const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

const currencyValueSchema = z
  .object({ currency: currencyCodeSchema, value: z.number().nonnegative() })
  .strict();

/** Non-empty, and no currency twice — two entries for `MYR` would make "the value for MYR"
 * ambiguous at payout time, which is not something a later screen can repair. */
const currencyValuesSchema = z
  .array(currencyValueSchema)
  .min(1)
  .refine(
    (values) => new Set(values.map((entry) => entry.currency)).size === values.length,
    'currencyValues must not repeat a currency',
  );

/**
 * `FIXED_AMOUNT` — single-currency or multi-currency, discriminated on `multiCurrency` itself so
 * the two shapes cannot be mixed (a `multiCurrency: true` config carrying `defaultValue`, or a
 * `multiCurrency: false` one carrying `currencyValues`, is rejected rather than half-read).
 */
export const fixedAmountValueConfigSchema = z.discriminatedUnion('multiCurrency', [
  z
    .object({
      multiCurrency: z.literal(false),
      defaultCurrency: currencyCodeSchema,
      defaultValue: z.number().nonnegative(),
    })
    .strict(),
  z.object({ multiCurrency: z.literal(true), currencyValues: currencyValuesSchema }).strict(),
]);

/** `PERCENTAGE` — 0–100 inclusive; a percentage outside that range is a typo, not a policy. */
export const percentageValueConfigSchema = z
  .object({ percentage: z.number().min(0).max(100) })
  .strict();

/** `POINTS` — a non-negative point count. */
export const pointsValueConfigSchema = z.object({ points: z.number().nonnegative() }).strict();

/** `PHYSICAL` — a stock-keeping unit and what it is, for a reward fulfilled off-platform. */
export const physicalValueConfigSchema = z
  .object({ sku: z.string().min(1).max(80), description: z.string().min(1).max(500) })
  .strict();

/**
 * The `field_api_lookup_providers` codes (T-121, §3) that may back a `PROMO_CODE` reward. Checked
 * here as a *known code*, never as an *active* one: §3 is explicit that authoring against a
 * `planned` provider is allowed, because nobody has confirmed the real endpoint/auth/response
 * keys yet and this work is not blocked waiting on them (TC-5). This file never queries the
 * database — whatever registry check belongs on top of "is this a known code" is the service
 * layer's, not this schema's.
 */
export const PROMO_CODE_API_PROVIDERS = ['PROMO_CODE_CONFIG_SERVICE'] as const;
export const promoCodeApiProviderSchema = z.enum(PROMO_CODE_API_PROVIDERS);

/** Where a Promo Code may be bound when a Maker attaches it (§5). */
export const PROMO_CODE_BIND_LEVELS = ['component', 'tracker', 'campaign'] as const;
export const promoCodeBindLevelSchema = z.enum(PROMO_CODE_BIND_LEVELS);
export type PromoCodeBindLevel = z.infer<typeof promoCodeBindLevelSchema>;

/**
 * `PROMO_CODE` — carries **no amount at all** (§5), only which config service issues the code and
 * at which levels it may be bound. The Maker's chosen Promo Code Config is stored at attach time
 * in the `reward_policies.config` JSON (T-127), not here.
 */
export const promoCodeValueConfigSchema = z
  .object({
    apiProvider: promoCodeApiProviderSchema,
    bindLevels: z
      .array(promoCodeBindLevelSchema)
      .min(1)
      .refine(
        (levels) => new Set(levels).size === levels.length,
        'bindLevels must not repeat a level',
      ),
  })
  .strict();

/**
 * The `(reward_kind, value_config)` pair — one discriminated union, so a config is only ever
 * validated against the kind it was actually authored for. Both halves are validated together
 * because neither is meaningful alone: `value_config` has no shape without a kind, and this is
 * the one place that mapping is written down.
 */
export const rewardVersionValueSchema = z.discriminatedUnion('rewardKind', [
  z
    .object({ rewardKind: z.literal('FIXED_AMOUNT'), valueConfig: fixedAmountValueConfigSchema })
    .strict(),
  z
    .object({ rewardKind: z.literal('PERCENTAGE'), valueConfig: percentageValueConfigSchema })
    .strict(),
  z.object({ rewardKind: z.literal('POINTS'), valueConfig: pointsValueConfigSchema }).strict(),
  z.object({ rewardKind: z.literal('PHYSICAL'), valueConfig: physicalValueConfigSchema }).strict(),
  z
    .object({ rewardKind: z.literal('PROMO_CODE'), valueConfig: promoCodeValueConfigSchema })
    .strict(),
]);

export type RewardVersionValue = z.infer<typeof rewardVersionValueSchema>;

/** The wire shape of `value_config` before its kind is known — a JSON object, nothing more. The
 * shape that actually matters is {@link rewardVersionValueSchema}'s, checked against the kind. */
export const rewardValueConfigSchema = z.record(z.string(), z.unknown());

/**
 * Whether `valueConfig` is well-formed **for `rewardKind`**. `null`/`undefined` `valueConfig` is
 * accepted for any kind (including none): a version whose kind is chosen but whose value is not
 * yet filled in is a legitimate draft state, and a version with neither is the pre-T-119 row every
 * existing `reward_versions` record still is (TC-7). A `valueConfig` with **no** kind is not
 * accepted — there is no schema to judge it by.
 */
export function isRewardVersionValue(
  rewardKind: RewardKind | null | undefined,
  valueConfig: unknown,
): boolean {
  if (valueConfig === null || valueConfig === undefined) return true;
  if (rewardKind === null || rewardKind === undefined) return false;
  return rewardVersionValueSchema.safeParse({ rewardKind, valueConfig }).success;
}

/** Shared by the create and update request schemas below (and by T-120's own form): reports the
 * pair check above as Zod issues, pathed at the field that is actually wrong. */
export function checkRewardVersionValue(
  value: {
    readonly rewardKind?: RewardKind | null;
    readonly valueConfig?: Record<string, unknown> | null;
  },
  ctx: z.RefinementCtx,
): void {
  const { rewardKind, valueConfig } = value;
  if (valueConfig === null || valueConfig === undefined) return;
  if (rewardKind === null || rewardKind === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rewardKind'],
      message: 'rewardKind is required when valueConfig is supplied',
    });
    return;
  }
  const result = rewardVersionValueSchema.safeParse({ rewardKind, valueConfig });
  if (result.success) return;
  for (const issue of result.error.issues) ctx.addIssue(issue);
}

/**
 * `POST /rewards/:rewardId/versions`. Everything about the cloned payload is server-decided
 * (`createVersionRequestSchema`'s own note) — `rewardKind`/`valueConfig` are the exception: a
 * fresh draft may be created with its Kind already chosen, which is how the Reward Master screen
 * (T-120) authors one in a single step.
 */
export const createRewardVersionRequestSchema = z
  .object({
    changeSummary: z.string().max(500).optional(),
    originRequestId: z.number().int().optional(),
    rewardKind: rewardKindSchema.nullable().optional(),
    valueConfig: rewardValueConfigSchema.nullable().optional(),
  })
  .strict()
  .superRefine(checkRewardVersionValue);

export type CreateRewardVersionRequest = z.infer<typeof createRewardVersionRequestSchema>;

/**
 * The `rewardKind`/`valueConfig` half of `PATCH /rewards/:rewardId/versions/:vid`, kept here (the
 * file T-119 owns) and spread into `updateRewardVersionRequestSchema` in `version.schema.ts`.
 *
 * A PATCH may legitimately send only one of the pair, in which case the other is whatever the
 * stored draft already holds — a merge only the server can perform, so the server re-checks the
 * *effective* pair with {@link isRewardVersionValue} rather than relying on this schema alone.
 */
export const rewardVersionValueRequestFields = {
  rewardKind: rewardKindSchema.nullable().optional(),
  valueConfig: rewardValueConfigSchema.nullable().optional(),
};

/**
 * The same two keys as they appear on a **response** (`rewardVersionSchema` in
 * `version.schema.ts`). `null` is "not set"; `.optional()` as well as `.nullable()` because a
 * server that predates this task sends neither key, and a `.strict()` client schema that
 * *required* them would reject every response from it during a rolling deploy.
 */
export const rewardVersionValueResponseFields = {
  rewardKind: rewardKindSchema.nullable().optional(),
  valueConfig: rewardValueConfigSchema.nullable().optional(),
};
