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

/** `reward_config.rule_master.status` / `reward_systems.status` — `ck_rm_status`. */
export const RULE_STATUSES = ['active', 'inactive'] as const;
export const ruleStatusSchema = z.enum(RULE_STATUSES);
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

/** The field types the campaign wizard's dynamic-value form knows how to render. */
export const RULE_PARAMETER_TYPES = ['string', 'number', 'boolean', 'date', 'select'] as const;
export const ruleParameterTypeSchema = z.enum(RULE_PARAMETER_TYPES);
export type RuleParameterType = z.infer<typeof ruleParameterTypeSchema>;

/** One field of a rule's `parameters` meta-schema. */
export const ruleParameterFieldSchema = z
  .object({
    /** The key a Maker's supplied value is keyed under at campaign time. Identifier-shaped —
     * this travels into a JSON object key and (eventually) into the rules engine's input. */
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    label: z.string().min(1).max(200),
    type: ruleParameterTypeSchema,
    required: z.boolean(),
    /** `type: 'select'` only — the choices a Maker may pick from. */
    options: z.array(z.string().min(1).max(100)).max(50).optional(),
    /** `type: 'number'` only — an inclusive bound the wizard enforces client-side. */
    min: z.number().optional(),
    max: z.number().optional(),
    helpText: z.string().max(500).optional(),
  })
  .strict()
  .refine((field) => field.type !== 'select' || (field.options?.length ?? 0) > 0, {
    message: "a 'select' field requires at least one option",
    path: ['options'],
  });

export type RuleParameterField = z.infer<typeof ruleParameterFieldSchema>;

/** `rule_master.parameters`, parsed. At most `RULE_PARAMETERS_MAX_FIELDS` (50) fields, each
 * with a `key` unique within the object — both enforced by `.refine` rather than by the shape
 * alone, since Zod's object/array primitives cannot express "unique across siblings". */
const ruleParametersShapeSchema = z
  .object({
    fields: z.array(ruleParameterFieldSchema).max(50),
  })
  .strict()
  .refine(
    (parameters) =>
      new Set(parameters.fields.map((field) => field.key)).size === parameters.fields.length,
    { message: 'field keys must be unique', path: ['fields'] },
  );

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

/** One row of `GET /rules` / `GET /rules/:id`. `expression` is inert text — never evaluated by
 * the portal (implementation note 5) — and is included here only for the editor screen. */
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
    parameters: ruleParametersSchema,
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
 * from (TC-15). */
export const ruleParametersEnvelopeSchema = z.object({ data: ruleParametersSchema }).strict();

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
