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
 * connector shapes no legacy row uses yet.
 */
export const REWARD_CONNECTOR_TYPES = ['internal_api', 'file_export', 'webhook', 'manual'] as const;
export const rewardConnectorTypeSchema = z.enum(REWARD_CONNECTOR_TYPES);
export type RewardConnectorType = z.infer<typeof rewardConnectorTypeSchema>;

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
  connectorType: rewardConnectorTypeSchema,
  maintenanceWindowEnabled: z.boolean(),
  maintenanceSchedule: jsonObjectSchema,
  retryEnabled: z.boolean(),
  retryConfig: jsonObjectSchema,
  merchantId: z.number().int().nullable(),
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
  })
  .strict();

export type CreateRewardRequest = z.infer<typeof createRewardRequestSchema>;

/** The request body of `PATCH /rewards/:id`. `systemCode` is immutable, never here. */
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
