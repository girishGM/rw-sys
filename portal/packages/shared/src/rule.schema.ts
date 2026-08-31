/**
 * T-031 — the wire contract of `/rules`, shared by the back end that produces it and the SPA
 * that consumes it (00-ARCHITECTURE.md §8: "One Zod schema shared with the back end via
 * `packages/shared` → identical client and server validation").
 *
 * ### Scope
 *
 * Bytes on the wire only, `.strict()` everywhere, same discipline `country.schema.ts` and
 * `bootstrap.schema.ts` state in full — no defaults the server never sent, no coercion, an
 * unexpected key fails the contract test rather than shipping silently.
 *
 * ### `ruleParametersSchema` is the one schema this file exists to get right
 *
 * `rule_master.parameters` is "the JSON contract the campaign wizard renders from"
 * (T-031 implementation note 4, 04-FRONTEND.md §5) — a small, self-describing form schema a
 * Maker fills in at campaign-creation time with the dynamic values a rule's `expression`
 * needs (a minimum-spend threshold, a tier list, a date range). `ruleParametersSchema` is the
 * **meta**-schema: the shape a rule author's `parameters` blob itself must have, not the
 * values a Maker will later supply against it. Both the back end (`RuleService.create/update`,
 * server-side, load-bearing) and the front end (the parameter-schema builder, client-side,
 * fail-fast UX) validate against this one definition, so the two can never silently drift.
 */
import { z } from 'zod';
import { providerCodeSchema } from './field-value-source.schema';

/** `reward_config.rule_master.status` / `reward_systems.status` — `ck_rm_status`. */
export const RULE_STATUSES = ['active', 'inactive'] as const;
export const ruleStatusSchema = z.enum(RULE_STATUSES);
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

/** The field types the campaign wizard's dynamic-value form knows how to render. */
export const RULE_PARAMETER_TYPES = ['string', 'number', 'boolean', 'date', 'select'] as const;
export const ruleParameterTypeSchema = z.enum(RULE_PARAMETER_TYPES);
export type RuleParameterType = z.infer<typeof ruleParameterTypeSchema>;

/**
 * T-122 — `13-REWARD-MASTER-VALUE-SOURCES.md` §3: where a `select` field's options come from,
 * when they are not the Super Admin's own hand-typed `options` array.
 *
 * There is deliberately **no `STATIC_LIST` variant**. A plain `select` with `options` and no
 * `valueSource` already *is* the fixed-list case; a third variant would be a second way to say
 * the same thing, and two representations of one state is how they drift apart.
 *
 * The provider code is validated with {@link providerCodeSchema}, the same constraint the
 * registries themselves apply on create (`field-value-source.schema.ts`, which anticipates this
 * reuse in its own comment) — not a bare `z.string()`. Nothing legitimate is rejected by it (a
 * provider cannot be registered under a code that fails that pattern), and it keeps an empty or
 * junk string from travelling as far as a registry lookup. Which codes actually *exist* is not
 * knowable here — that is a live registry read, done server-side in `rules.service.ts`.
 */
export const RULE_FIELD_VALUE_SOURCE_KINDS = ['CONTEXT_LOOKUP', 'API_LOOKUP'] as const;

export const ruleFieldValueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CONTEXT_LOOKUP'), contextProvider: providerCodeSchema }).strict(),
  z.object({ kind: z.literal('API_LOOKUP'), apiProvider: providerCodeSchema }).strict(),
]);

export type RuleFieldValueSource = z.infer<typeof ruleFieldValueSourceSchema>;

/** The shape shared by every field of a rule's `parameters` meta-schema — the request/write
 * form (`ruleParameterFieldSchema`, below) and the response-only, role-annotated form
 * (`ruleParameterFieldWithRoleSchema`, T-114) both `.extend()` this same base rather than
 * duplicating its fields, so the two can never silently drift. */
const ruleParameterFieldBaseSchema = z
  .object({
    /** The key a Maker's supplied value is keyed under at campaign time. Identifier-shaped —
     * this travels into a JSON object key and (eventually) into the rules engine's input. */
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    label: z.string().min(1).max(200),
    type: ruleParameterTypeSchema,
    required: z.boolean(),
    /** `type: 'select'` only — the choices a Maker may pick from, hand-typed by the rule author. */
    options: z.array(z.string().min(1).max(100)).max(50).optional(),
    /** T-122 — `type: 'select'` only, and mutually *alternative* to `options` rather than
     * exclusive with it: the choices come from a registered context/API lookup provider instead
     * of being typed out here. See {@link ruleFieldValueSourceSchema}. */
    valueSource: ruleFieldValueSourceSchema.optional(),
    /** `type: 'number'` only — an inclusive bound the wizard enforces client-side. */
    min: z.number().optional(),
    max: z.number().optional(),
    helpText: z.string().max(500).optional(),
  })
  .strict();

/** The subset of a parameter field the two cross-key refinements below read. Declared once so
 * both predicates, and both the write and response shapes that apply them, agree on it. */
interface RuleParameterFieldConstraints {
  readonly type: RuleParameterType;
  readonly options?: string[];
  readonly valueSource?: RuleFieldValueSource;
}

/**
 * A `'select'` field must say where its choices come from — **either** at least one hand-typed
 * `options` entry **or** a `valueSource` (T-122). Never both required: those are the two ways to
 * populate one dropdown, and requiring `options` alongside a `valueSource` would force the rule
 * author to hand-type the very list the provider exists to supply.
 *
 * Supplying both is *permitted* rather than rejected — a fixed list plus a provider is a
 * meaningful authoring state (T-125 decides how to present it), and the task's own wording is
 * "valid when either is present", not "exactly one".
 */
function requireOptionsOrValueSourceOnSelect(field: RuleParameterFieldConstraints): boolean {
  return (
    field.type !== 'select' || (field.options?.length ?? 0) > 0 || field.valueSource !== undefined
  );
}
const SELECT_OPTIONS_REFINEMENT: { message: string; path: string[] } = {
  message: "a 'select' field requires at least one option or a valueSource",
  path: ['options'],
};

/** T-122 — a `valueSource` populates a dropdown, so it only means anything on a `select` field.
 * Setting one on a `string`/`number`/`boolean`/`date` field is an authoring mistake that would
 * otherwise be stored and silently ignored forever (TC-6). */
function valueSourceOnlyOnSelect(field: RuleParameterFieldConstraints): boolean {
  return field.valueSource === undefined || field.type === 'select';
}
const VALUE_SOURCE_TYPE_REFINEMENT: { message: string; path: string[] } = {
  message: "only a 'select' field may declare a valueSource",
  path: ['valueSource'],
};

/** One field of a rule's `parameters` meta-schema — the request/write shape. `role` (T-114,
 * §2 below) is deliberately **not** a key here: it is never client-writable, and a request body
 * that supplies one 400s via this `.strict()` (T-114 TC-6) rather than being silently accepted
 * or ignored. */
export const ruleParameterFieldSchema = ruleParameterFieldBaseSchema
  .refine(requireOptionsOrValueSourceOnSelect, SELECT_OPTIONS_REFINEMENT)
  .refine(valueSourceOnlyOnSelect, VALUE_SOURCE_TYPE_REFINEMENT);

export type RuleParameterField = z.infer<typeof ruleParameterFieldSchema>;

/**
 * T-114 — `13-REWARD-MASTER-VALUE-SOURCES.md` §2: does the Maker's value for this field feed
 * the rule's wired resolver's own lookup (`resolver_input`), or get compared against the fact
 * the resolver returns (`compare_value`)? Server-computed, per response, from
 * `rule_resolvers.resolver_input_field_keys` — never a manually-chosen or client-writable
 * property. This enum and `ruleParameterFieldWithRoleSchema` below back the **response-only**
 * extension of {@link ruleParameterFieldSchema}; the write schema itself never gains this key.
 */
export const RULE_FIELD_ROLES = ['compare_value', 'resolver_input'] as const;
export const ruleFieldRoleSchema = z.enum(RULE_FIELD_ROLES);
export type RuleFieldRole = z.infer<typeof ruleFieldRoleSchema>;

/** Response-only counterpart of {@link ruleParameterFieldSchema}, `role` added. Used exclusively
 * by response DTOs (`ruleSchema`, `ruleParametersEnvelopeSchema`) — never by
 * `createRuleRequestSchema`/`updateRuleRequestSchema`. */
export const ruleParameterFieldWithRoleSchema = ruleParameterFieldBaseSchema
  .extend({ role: ruleFieldRoleSchema })
  .strict()
  .refine(requireOptionsOrValueSourceOnSelect, SELECT_OPTIONS_REFINEMENT)
  .refine(valueSourceOnlyOnSelect, VALUE_SOURCE_TYPE_REFINEMENT);

export type RuleParameterFieldWithRole = z.infer<typeof ruleParameterFieldWithRoleSchema>;

/** At most `RULE_PARAMETERS_MAX_FIELDS` (50) fields, each with a `key` unique within the
 * object — enforced by `.refine` rather than by the shape alone, since Zod's object/array
 * primitives cannot express "unique across siblings". Shared by both the write shape below and
 * its response-only, role-annotated counterpart (T-114) so the uniqueness rule can never drift
 * between the two. */
function uniqueFieldKeys(parameters: { fields: ReadonlyArray<{ key: string }> }): boolean {
  return new Set(parameters.fields.map((field) => field.key)).size === parameters.fields.length;
}
const UNIQUE_FIELD_KEYS_REFINEMENT: { message: string; path: string[] } = {
  message: 'field keys must be unique',
  path: ['fields'],
};

/** `rule_master.parameters`, parsed — the write shape. */
const ruleParametersShapeSchema = z
  .object({
    fields: z.array(ruleParameterFieldSchema).max(50),
  })
  .strict()
  .refine(uniqueFieldKeys, UNIQUE_FIELD_KEYS_REFINEMENT);

/**
 * T-074 (fix). `rule_master.parameters` is `text` holding JSON, and its own model getter
 * (`rule-master.model.ts`'s `parseJsonColumn`) is documented to fall back to a bare `{}` for
 * absent or malformed stored content — "never throws… one bad legacy row must not break a
 * whole list endpoint" (T-003 TC-8). A bare `{}` and `{ fields: [] }` are the same "no
 * parameters" value; before this fix, only the latter satisfied this schema, so that documented
 * "never throws" promise silently broke the moment the value reached this shared contract
 * (T-074 root cause — `rules.service.ts#create` also wrote the bare form for an omitted
 * `parameters`, which is why every newly created rule with no parameters tripped this). This
 * preprocessing step is what makes the two forms equivalent everywhere this schema is used —
 * server-side validation, the `/rules` response contract and the front-end parameter-schema
 * builder alike — rather than patching just the one write path that happened to be reported.
 * Anything that is not a bare, empty plain object (e.g. `{ fields: [] }` itself, or a genuinely
 * malformed shape like `{ extra: true }`) passes through unchanged and is still checked in
 * full by `.strict()` below.
 */
function normaliseEmptyRuleParameters(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return { fields: [] };
  }
  return value;
}

export const ruleParametersSchema = z.preprocess(
  normaliseEmptyRuleParameters,
  ruleParametersShapeSchema,
);

export type RuleParameters = z.infer<typeof ruleParametersSchema>;

/**
 * T-114 — the response-only counterpart of {@link ruleParametersSchema}: identical shape, every
 * field additionally carrying the server-computed `role` {@link ruleParameterFieldWithRoleSchema}
 * defines. Backs `ruleSchema.parameters` and `ruleParametersEnvelopeSchema` below — never a
 * request/write schema, so a client cannot submit a `role` and have it silently accepted (T-114
 * TC-6: it 400s against the unmodified {@link ruleParametersSchema} instead).
 */
const ruleParametersWithRoleShapeSchema = z
  .object({
    fields: z.array(ruleParameterFieldWithRoleSchema).max(50),
  })
  .strict()
  .refine(uniqueFieldKeys, UNIQUE_FIELD_KEYS_REFINEMENT);

export const ruleParametersWithRoleSchema = z.preprocess(
  normaliseEmptyRuleParameters,
  ruleParametersWithRoleShapeSchema,
);

export type RuleParametersWithRole = z.infer<typeof ruleParametersWithRoleSchema>;

/** One row of `GET /rules` / `GET /rules/:id`. `expression` is inert text — never evaluated by
 * the portal (implementation note 5) — and is included here only for the editor screen.
 * `parameters` is the response-only, role-annotated shape (T-114) — this is a read path, never
 * the request body a Maker/Super Admin submits. */
export const ruleSchema = z
  .object({
    id: z.number().int(),
    ruleCode: z.string(),
    name: z.string(),
    categoryId: z.number().int(),
    categoryName: z.string(),
    subCategoryId: z.number().int(),
    subCategoryName: z.string(),
    expression: z.string().nullable(),
    parameters: ruleParametersWithRoleSchema,
    status: ruleStatusSchema,
    createdBy: z.number().int().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type Rule = z.infer<typeof ruleSchema>;

export const listMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .strict();

export const ruleListEnvelopeSchema = z
  .object({ data: z.array(ruleSchema), meta: listMetaSchema })
  .strict();

export const ruleEnvelopeSchema = z.object({ data: ruleSchema }).strict();

/** The request body of `POST /rules`. `tenant_id` is never here (AGENT-PROTOCOL R3) — the
 * server always writes `NULL` for a global rule (01-DATABASE.md §4). */
export const createRuleRequestSchema = z
  .object({
    ruleCode: z.string().min(2).max(80),
    name: z.string().min(1).max(200),
    subCategoryId: z.number().int(),
    expression: z.string().max(8000).optional(),
    parameters: ruleParametersSchema.optional(),
  })
  .strict();

export type CreateRuleRequest = z.infer<typeof createRuleRequestSchema>;

/** The request body of `PATCH /rules/:id`. `ruleCode` is immutable, same discipline
 * `country.schema.ts` applies to `code` — never here. */
export const updateRuleRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    subCategoryId: z.number().int().optional(),
    expression: z.string().max(8000).nullable().optional(),
    parameters: ruleParametersSchema.optional(),
    status: ruleStatusSchema.optional(),
  })
  .strict();

export type UpdateRuleRequest = z.infer<typeof updateRuleRequestSchema>;

/** `GET /rules/:id/parameters` — the parsed schema a Maker's campaign-wizard form renders
 * from (TC-15). Role-annotated (T-114) — same reasoning `ruleSchema.parameters` documents:
 * this is a read path, so the wizard knows which fields to render as Maker input
 * (`compare_value`) versus which are consumed by the resolver itself (`resolver_input`). */
export const ruleParametersEnvelopeSchema = z
  .object({ data: ruleParametersWithRoleSchema })
  .strict();

/** One row of `GET /rules/:id/countries` — a `rule_country_assignments` row, joined for
 * display. */
export const ruleCountryAssignmentSchema = z
  .object({
    id: z.number().int(),
    ruleId: z.number().int(),
    countryId: z.number().int(),
    countryCode: z.string(),
    countryName: z.string(),
    assignedAt: z.string(),
    assignedBy: z.number().int().nullable(),
  })
  .strict();

export type RuleCountryAssignment = z.infer<typeof ruleCountryAssignmentSchema>;

export const ruleCountryAssignmentListEnvelopeSchema = z
  .object({ data: z.array(ruleCountryAssignmentSchema) })
  .strict();

/** `POST /rules/:id/countries`'s response — one assignment row, not a list. */
export const ruleCountryAssignmentEnvelopeSchema = z
  .object({ data: ruleCountryAssignmentSchema })
  .strict();

/** The request body of `POST /rules/:id/countries` — implementation note 6: "Assignment writes
 * `rule_country_assignments` with `assigned_by`" (from the verified actor, never the body). */
export const assignRuleCountryRequestSchema = z.object({ countryId: z.number().int() }).strict();

export type AssignRuleCountryRequest = z.infer<typeof assignRuleCountryRequestSchema>;

/** `GET /rule-categories`. Read-only reference data (03-API-CONTRACT.md §8). */
export const ruleCategorySchema = z
  .object({
    id: z.number().int(),
    categoryCode: z.string(),
    name: z.string(),
    status: z.string(),
  })
  .strict();

export type RuleCategory = z.infer<typeof ruleCategorySchema>;

export const ruleCategoryListEnvelopeSchema = z
  .object({ data: z.array(ruleCategorySchema) })
  .strict();

/** `GET /rule-sub-categories`. Read-only reference data (03-API-CONTRACT.md §8). */
export const ruleSubCategorySchema = z
  .object({
    id: z.number().int(),
    categoryId: z.number().int(),
    subCategoryCode: z.string(),
    name: z.string(),
    status: z.string(),
  })
  .strict();

export type RuleSubCategory = z.infer<typeof ruleSubCategorySchema>;

export const ruleSubCategoryListEnvelopeSchema = z
  .object({ data: z.array(ruleSubCategorySchema) })
  .strict();

/** `POST /rule-categories`. `categoryCode` is immutable once created, same discipline
 * `createRuleRequestSchema` applies to `ruleCode` — never in the update schema below. */
export const createRuleCategoryRequestSchema = z
  .object({
    categoryCode: z.string().min(2).max(50),
    name: z.string().min(1).max(200),
  })
  .strict();

export type CreateRuleCategoryRequest = z.infer<typeof createRuleCategoryRequestSchema>;

export const updateRuleCategoryRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: ruleStatusSchema.optional(),
  })
  .strict();

export type UpdateRuleCategoryRequest = z.infer<typeof updateRuleCategoryRequestSchema>;

export const ruleCategoryEnvelopeSchema = z.object({ data: ruleCategorySchema }).strict();

/** `POST /rule-sub-categories`. Moving a sub-category to a different category is out of
 * scope (T-106) — `categoryId` is write-once, at creation, and absent from the update schema. */
export const createRuleSubCategoryRequestSchema = z
  .object({
    categoryId: z.number().int(),
    subCategoryCode: z.string().min(2).max(50),
    name: z.string().min(1).max(200),
  })
  .strict();

export type CreateRuleSubCategoryRequest = z.infer<typeof createRuleSubCategoryRequestSchema>;

export const updateRuleSubCategoryRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: ruleStatusSchema.optional(),
  })
  .strict();

export type UpdateRuleSubCategoryRequest = z.infer<typeof updateRuleSubCategoryRequestSchema>;

export const ruleSubCategoryEnvelopeSchema = z.object({ data: ruleSubCategorySchema }).strict();

/** `GET /rule-resolvers`. Read-only reference data (T-108) — declares *how* to fetch a fact;
 * `handlerClass`/`inputSchema` are backend-only and deliberately not part of this wire contract.
 * `resolverInputFieldKeys` (T-114) is the data a parameter field's `role` is computed from — see
 * `ruleFieldRoleSchema` above; exposed here so the Super Admin's rule editor (T-115) can explain
 * *why* a given field is `resolver_input`, not just that it is. */
export const ruleResolverSchema = z
  .object({
    id: z.number().int(),
    resolverCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    resolverInputFieldKeys: z.array(z.string()),
  })
  .strict();

export type RuleResolver = z.infer<typeof ruleResolverSchema>;

export const ruleResolverListEnvelopeSchema = z
  .object({ data: z.array(ruleResolverSchema) })
  .strict();

/** `GET /rule-operators`. Read-only reference data (T-108). */
export const ruleOperatorSchema = z
  .object({
    id: z.number().int(),
    operatorCode: z.string(),
    displayName: z.string(),
    expectedValueType: z.string(),
    status: z.string(),
  })
  .strict();

export type RuleOperator = z.infer<typeof ruleOperatorSchema>;

export const ruleOperatorListEnvelopeSchema = z
  .object({ data: z.array(ruleOperatorSchema) })
  .strict();
