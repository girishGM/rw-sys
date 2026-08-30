/**
 * T-037 — the wire contract of `/campaigns`: the seven-step maker wizard, the journey
 * (tracker → component) tree, component-scoped rule binding with dynamic values, the three
 * reward-attachment levels, budgets/limits, and submission.
 *
 * Same discipline every other `*.schema.ts` in this package states in full: bytes on the wire
 * only, `.strict()` everywhere, no coercion, no defaults the server never sent — an unexpected
 * key fails the contract test rather than shipping silently.
 *
 * ### Money and time never cross this boundary as a `number`
 *
 * Every monetary amount (`budgetAmount`, `maxTotalAmount`, the ceiling figures) is a **decimal
 * string**, matching `campaign-cap.model.ts`'s own rule (*"Sequelize returns Postgres `numeric`
 * as a string — never coerce to a JS number; money crosses every boundary as a string, never a
 * float"*) and 11-BUDGETS-AND-LIMITS.md §5's identical rule for the gRPC contract.
 *
 * A campaign's own start/end are **calendar dates**, not instants — `YYYY-MM-DD`, see
 * {@link calendarDateSchema} and T-065. Every *other* time on this boundary (an approval's
 * `requestedAt`, an audit row's `performedAt`) genuinely is an instant and stays
 * {@link isoDateTimeSchema}'s shape: the distinction is the whole point, not an inconsistency.
 *
 * ### {@link buildRuleValueSchema} is the one export this file exists to get right
 *
 * T-031 owns the rule-parameter **meta**-schema (`ruleParametersSchema` — *what shape a rule
 * author's `parameters` blob has*). This file owns the other half: given one of those blobs,
 * what shape must a **maker's supplied values** have? That question is answered exactly once,
 * here, and both sides consume the answer — `DynamicParameterForm` renders and validates a form
 * from it (04-FRONTEND.md §5.4), and `CampaignRuleBindingService` re-validates the submitted
 * values against the *same* function server-side (T-037 implementation note 9: *"client-built
 * validation is trivially bypassed"*, TC-17). Two independent implementations of this rule would
 * be two implementations that drift, and the drift would be silent in exactly the direction that
 * matters — the server accepting what the client rejects.
 */
import { z } from 'zod';
import { ruleParametersSchema, type RuleParameterField, type RuleParameters } from './rule.schema';
import { promoCodeBindLevelSchema, rewardKindSchema } from './reward.schema';

// --- primitives ---------------------------------------------------------------------------------

/**
 * An ISO-8601 instant with an explicit offset (`2026-09-01T00:00:00+08:00` or a `Z` form).
 *
 * The offset is **required**, not optional: 04-FRONTEND.md §5.6 / implementation note 11 —
 * *"a campaign starting 'today' in Kuala Lumpur and 'yesterday' in UTC is a real and confusing
 * bug"*. A bare `2026-09-01T00:00:00` is ambiguous about which of those two days the maker
 * meant, so the contract refuses it rather than guessing (TC-10).
 *
 * **No longer the type of a campaign's own start/end date** — see {@link campaignDateSchema} and
 * T-065. It is retained because it is still the right shape for an *instant* (an approval's
 * `requestedAt`, an audit row's `performedAt`) and because a client written against the
 * pre-T-065 contract still sends this form for a campaign date, which that schema accepts.
 */
export const isoDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/,
    'must be an ISO-8601 instant carrying an explicit UTC offset',
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a real date');

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A **calendar date** — `YYYY-MM-DD`, no time, no offset. What a campaign's start and end
 * actually are (T-065).
 *
 * *"Ends 15 Feb 2027"* means the same day in Kuala Lumpur and in London. Encoding that as an
 * instant does not add precision, it adds a lie: the pre-T-065 wizard sent the end date as
 * `<day>T23:59:59` **in the browser's own offset**, so the identical campaign read back as the
 * 15th in UTC and the 16th in `Asia/Kolkata` — a campaign running a day longer than the one that
 * was approved. A date with no time cannot drift across a day boundary, because it has no
 * boundary to cross.
 *
 * The `.refine` rejects a well-shaped string that is not a real day (`2027-02-30`) by round-
 * tripping it: `Date.parse` happily rolls that over to 2 March, and a silently-rolled-over date
 * is worse than a rejected one.
 */
export const calendarDateSchema = z
  .string()
  .regex(CALENDAR_DATE_PATTERN, 'must be a YYYY-MM-DD calendar date')
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }, 'must be a real calendar date');

/**
 * What `startDate`/`endDate` accept on a campaign write.
 *
 * A calendar date is the contract. An ISO instant carrying an explicit offset is *also* accepted
 * and read as **the calendar day it names in its own offset** — `2027-02-15T23:59:59+05:30` is
 * the 15th, not the 16th. That branch is compatibility, not a second contract: every client that
 * predates T-065 (the pre-fix SPA, T-050's API-level fixtures, any integration already written
 * against `isoDateTimeSchema`) sends an instant, and refusing it would break them for no
 * correctness gain — the value is reduced to a day either way, by exactly one function
 * ({@link calendarDayOf}), before anything is stored or compared.
 *
 * Responses are always the plain calendar form; see {@link campaignSchema}.
 */
export const campaignDateSchema = z.union([calendarDateSchema, isoDateTimeSchema]);

/**
 * The calendar day a campaign date names, in whichever accepted form it arrived, or `null` when
 * the value is neither form.
 *
 * The one place this rule is written down for the wire contract. `null` rather than a throw: every
 * caller here is a `.refine` running *alongside* the per-field checks that reject a malformed
 * value, and a refinement that throws turns a 400 into a 500.
 */
function calendarDayOf(value: string): string | null {
  if (CALENDAR_DATE_PATTERN.test(value)) return value;
  const offsetMinutes = parseOffsetMinutes(value);
  const parsed = Date.parse(value);
  if (offsetMinutes === null || Number.isNaN(parsed)) return null;
  return new Date(parsed + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * A non-negative decimal amount as a string — never a float. Up to 4 decimal places, matching
 * `campaign_caps.max_total_amount` (`decimal(18,4)`); `tenant_campaigns.budget_amount` is the
 * narrower `decimal(18,2)` and is validated separately by {@link legacyMoneySchema}.
 */
export const moneySchema = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'must be a non-negative decimal amount with at most 4 places');

/** `tenant_campaigns.budget_amount` is `decimal(18,2)` — two places, not four. */
export const legacyMoneySchema = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, 'must be a non-negative decimal amount with at most 2 places');

/** `HH:MM` or `HH:MM:SS` — `campaign_caps.window_start_time`/`window_end_time` are `time`. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be HH:MM or HH:MM:SS');

/** ISO-4217-shaped, or a points/voucher unit code. `campaign_caps.unit_code` is `varchar(10)`. */
export const unitCodeSchema = z.string().regex(/^[A-Z0-9_]{1,10}$/);

/** `tenant_campaigns.budget_currency` is `char(3)`. */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

// --- campaign ----------------------------------------------------------------------------------

/**
 * `ck_tc_status`, verbatim from the live constraint.
 *
 * **`returned` is deliberately absent**, and this is a documented deviation rather than an
 * omission: 03-API-CONTRACT.md §11's state diagram shows a `returned` state, but the live
 * `ck_tc_status` CHECK permits only these six values and R1 forbids altering it. A returned
 * campaign is therefore **stored** as `draft` and **presented** as `returned`, derived from its
 * own last approval decision — see {@link campaignSchema}'s `effectiveStatus`. The maker-visible
 * behaviour ("it came back to me with a comment, and I can edit it again") is identical either
 * way; what changes is only which column carries the fact.
 */
export const CAMPAIGN_STATUSES = [
  'draft',
  'pending_approval',
  'active',
  'paused',
  'completed',
  'archived',
] as const;
export const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

/** What the UI renders. `returned` is the derived seventh state — see {@link CAMPAIGN_STATUSES}. */
export const CAMPAIGN_EFFECTIVE_STATUSES = [...CAMPAIGN_STATUSES, 'returned'] as const;
export const campaignEffectiveStatusSchema = z.enum(CAMPAIGN_EFFECTIVE_STATUSES);
export type CampaignEffectiveStatus = z.infer<typeof campaignEffectiveStatusSchema>;

/** One row of `GET /campaigns` / the header of `GET /campaigns/:id`. */
export const campaignSchema = z
  .object({
    id: z.number().int(),
    tenantId: z.number().int(),
    campaignCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    /**
     * `YYYY-MM-DD`, always — never an instant (T-065). Typed as {@link calendarDateSchema} rather
     * than a bare `z.string()` on purpose: the SPA parses every response through this schema, so a
     * server that regressed to `toISOString()` fails the contract in the client that renders it,
     * instead of quietly shifting a date by a day for half the world's offsets.
     */
    startDate: calendarDateSchema,
    /** The campaign's **last active day**, inclusive. See {@link startDate}. */
    endDate: calendarDateSchema,
    status: campaignStatusSchema,
    /** {@link CAMPAIGN_STATUSES} plus the derived `returned`. What the UI shows. */
    effectiveStatus: campaignEffectiveStatusSchema,
    maxParticipants: z.number().int().nullable(),
    /** Decimal string — the legacy lifetime budget, dual-written with `campaign_caps`. */
    budgetAmount: z.string().nullable(),
    budgetCurrency: z.string().nullable(),
    createdBy: z.string(),
    approvedBy: z.string().nullable(),
    approvedAt: z.string().nullable(),
    /** The comment from the last reject/return, when there is one. Drives the maker's banner. */
    lastReviewComment: z.string().nullable(),
    /** Whether the caller may still edit — `draft` only (implementation note 3). */
    editable: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type Campaign = z.infer<typeof campaignSchema>;

export const campaignListMetaSchema = z
  .object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() })
  .strict();

export const campaignListEnvelopeSchema = z
  .object({ data: z.array(campaignSchema), meta: campaignListMetaSchema })
  .strict();

export const campaignEnvelopeSchema = z.object({ data: campaignSchema }).strict();

/**
 * The date pair every campaign write shares. Declared once so `create` and `update` cannot
 * disagree (implementation note 11 / TC-8 / TC-9).
 *
 * Both rules compare **calendar days**, never instants — T-065. Reducing each value to its day
 * first is what makes the pair's meaning independent of who is looking at it.
 *
 * ### `endDate >= startDate`, not `>`
 *
 * The end date is the campaign's **last active day, inclusive**, so a campaign that starts and
 * ends on the 15th runs for one day — not for zero. Under the pre-T-065 encoding the identical
 * campaign was `15th T00:00:00+08:00` → `15th T23:59:59+08:00`, two distinct instants that
 * satisfied a strict `>`; keeping `>` after the encoding changed would silently withdraw
 * single-day campaigns, which no one asked for. `>` still holds where it means something: an end
 * *before* the start is refused. Recorded as a deviation from 04-FRONTEND.md §5.6's literal
 * `endDate > startDate` in the T-065 completion report.
 */
function refineDates<T extends { startDate?: string; endDate?: string }>(schema: z.ZodType<T>) {
  return schema
    .refine(
      (value) => {
        if (value.startDate === undefined || value.endDate === undefined) return true;
        const start = calendarDayOf(value.startDate);
        const end = calendarDayOf(value.endDate);
        // Either being unreadable is another rule's 400 to report, not this one's.
        if (start === null || end === null) return true;
        return end >= start;
      },
      { message: 'endDate must not be before startDate', path: ['endDate'] },
    )
    .refine(
      (value) => value.startDate === undefined || !isBeforeTodayInItsOwnOffset(value.startDate),
      {
        message: 'startDate must not be in the past',
        path: ['startDate'],
      },
    );
}

/**
 * Whether the calendar day `value` names has already passed **everywhere on Earth**.
 *
 * Accepts either accepted campaign-date form (see {@link campaignDateSchema}); anything else
 * answers `false`, because rejecting a malformed value is the field validator's job and a
 * refinement that double-reports one produces two errors for one mistake.
 *
 * ### Why "everywhere", and why that is the *only* defensible floor for a calendar date
 *
 * The pre-T-065 version compared against today reckoned in the offset the maker sent — which
 * worked precisely because the value carried an offset. A calendar date carries none, and this
 * portal is multi-country by design, so there is no single "today" to compare against: at
 * 2026-09-01T02:00Z it is already the 1st in Auckland and still the 31st in Honolulu. The floor
 * is therefore today at **UTC−12**, the earliest civil date in use at any instant: a start date is
 * refused only once it is in the past for every maker alive. Erring the other way — refusing a
 * date that is genuinely still today for the person typing it — is the exact class of bug T-065
 * exists to remove, and this guard is a courtesy to the maker, not a security control.
 *
 * The name is now narrower than the behaviour ("its own offset" is one of two accepted forms).
 * It is kept because `packages/shared/src/index.ts`, the barrel that re-exports it, is another
 * task's owned file (AGENT-PROTOCOL R9) — flagged in the T-065 report as a rename to fold into
 * whichever task next owns that barrel.
 */
export function isBeforeTodayInItsOwnOffset(value: string, now: Date = new Date()): boolean {
  const day = calendarDayOf(value);
  if (day === null) return false;
  const earliestTodayAnywhere = new Date(now.getTime() - 12 * 3_600_000).toISOString().slice(0, 10);
  return day < earliestTodayAnywhere;
}

function parseOffsetMinutes(iso: string): number | null {
  if (iso.endsWith('Z')) return 0;
  const match = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (match === null) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * `POST /campaigns` — step 1 of the wizard.
 *
 * No `tenantId`, no `status`, no `createdBy` (AGENT-PROTOCOL R3): all three come from the
 * actor's verified scope, never from the body. `budgetAmount` and `budgetCurrency` travel
 * together or not at all — TC-11 (*"budget amount with no currency → 400"*), rejected here on
 * the client **and** by the identical server-side parse.
 */
export const createCampaignRequestSchema = refineDates(
  z
    .object({
      campaignCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/),
      name: z.string().min(1).max(200),
      description: z.string().max(4000).optional(),
      startDate: campaignDateSchema,
      endDate: campaignDateSchema,
      maxParticipants: z.number().int().positive().max(1_000_000_000).optional(),
      budgetAmount: legacyMoneySchema.optional(),
      budgetCurrency: currencyCodeSchema.optional(),
    })
    .strict(),
).refine((value) => value.budgetAmount === undefined || value.budgetCurrency !== undefined, {
  message: 'budgetCurrency is required when budgetAmount is set',
  path: ['budgetCurrency'],
});

export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>;

/** `PATCH /campaigns/:id`. `campaignCode` is immutable once written — it is the tenant-unique
 * business key other systems already hold. */
export const updateCampaignRequestSchema = refineDates(
  z
    .object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(4000).nullable().optional(),
      startDate: campaignDateSchema.optional(),
      endDate: campaignDateSchema.optional(),
      maxParticipants: z.number().int().positive().max(1_000_000_000).nullable().optional(),
      budgetAmount: legacyMoneySchema.nullable().optional(),
      budgetCurrency: currencyCodeSchema.nullable().optional(),
    })
    .strict(),
).refine(
  (value) =>
    value.budgetAmount === undefined ||
    value.budgetAmount === null ||
    value.budgetCurrency !== undefined,
  { message: 'budgetCurrency is required when budgetAmount is set', path: ['budgetCurrency'] },
);

export type UpdateCampaignRequest = z.infer<typeof updateCampaignRequestSchema>;

// --- step 2: merchants --------------------------------------------------------------------------

/** `POST /campaigns/:id/merchants` — replaces the participating set wholesale (TC-12/TC-13). */
export const setCampaignMerchantsRequestSchema = z
  .object({ merchantIds: z.array(z.number().int().positive()).max(200) })
  .strict();

export type SetCampaignMerchantsRequest = z.infer<typeof setCampaignMerchantsRequestSchema>;

export const campaignMerchantSchema = z
  .object({
    id: z.number().int(),
    merchantId: z.number().int(),
    merchantCode: z.string(),
    name: z.string(),
    status: z.string(),
  })
  .strict();

export type CampaignMerchantLink = z.infer<typeof campaignMerchantSchema>;

export const campaignMerchantListEnvelopeSchema = z
  .object({ data: z.array(campaignMerchantSchema) })
  .strict();

/** One row of `GET /campaigns/:id/activities` — the activities the step-2 merchants offer, and
 * therefore the only ones a component may target (implementation note 8, TC-21h). */
export const campaignActivityOptionSchema = z
  .object({
    activityId: z.number().int(),
    activityCode: z.string(),
    name: z.string(),
    merchantIds: z.array(z.number().int()),
  })
  .strict();

export type CampaignActivityOption = z.infer<typeof campaignActivityOptionSchema>;

export const campaignActivityOptionListEnvelopeSchema = z
  .object({ data: z.array(campaignActivityOptionSchema) })
  .strict();

// --- step 3: the journey ------------------------------------------------------------------------

/** `ck_trk_logic`. */
export const TRACKER_COMPLETION_LOGICS = ['all', 'any', 'n_of'] as const;
export const trackerCompletionLogicSchema = z.enum(TRACKER_COMPLETION_LOGICS);
export type TrackerCompletionLogic = z.infer<typeof trackerCompletionLogicSchema>;

/**
 * `POST /campaigns/:id/trackers`.
 *
 * `completionThreshold` is only meaningful for `n_of`. Its relationship to the **component
 * count** (≥ 1 and ≤ count — TC-21e/TC-21f) cannot be checked here, because the count is server
 * state this request does not carry; that check lives in the service, where it is authoritative
 * (implementation note 4: *"a threshold above the count creates a tracker no customer can ever
 * complete"*).
 */
export const createTrackerRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    completionLogic: trackerCompletionLogicSchema,
    completionThreshold: z.number().int().min(1).max(1000).optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.completionLogic !== 'n_of' || value.completionThreshold !== undefined, {
    message: "completionThreshold is required when completionLogic is 'n_of'",
    path: ['completionThreshold'],
  });

export type CreateTrackerRequest = z.infer<typeof createTrackerRequestSchema>;

export const updateTrackerRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).nullable().optional(),
    completionLogic: trackerCompletionLogicSchema.optional(),
    completionThreshold: z.number().int().min(1).max(1000).nullable().optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

export type UpdateTrackerRequest = z.infer<typeof updateTrackerRequestSchema>;

/**
 * `POST /campaigns/:id/trackers/:trackerId/components`.
 *
 * `activityId` is the **only** targeting dimension a component has in v1 — no product or SKU
 * selector exists or may be built (12-CAMPAIGN-STRUCTURE.md §2, BACKLOG B-14, implementation
 * note 7b). `groupCode` is likewise absent by design (note 7c, §1.5): the column exists and the
 * wizard writes `NULL` throughout.
 */
export const createComponentRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    activityId: z.number().int().positive(),
    sequenceOrder: z.number().int().min(1).max(1000).optional(),
    isMandatory: z.boolean().optional(),
  })
  .strict();

export type CreateComponentRequest = z.infer<typeof createComponentRequestSchema>;

/**
 * T-147 — `ruleLogic`/`ruleThreshold`: the component-level "rules combine" contract T-104 added,
 * mirroring `trackers.completion_logic`/`.completion_threshold` one level up (same three values,
 * same `n_of`-needs-a-threshold shape, same `createTrackerRequestSchema` precedent below). Always
 * sent together, never as a partial update of just one — the two-sided refine only has enough
 * information to enforce "n_of requires a threshold, anything else forbids one" when both fields
 * reflect what this request is actually setting, not a mix of "what the caller sent" and "what
 * was already in the database".
 */
export const updateComponentRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).nullable().optional(),
    activityId: z.number().int().positive().optional(),
    sequenceOrder: z.number().int().min(1).max(1000).optional(),
    isMandatory: z.boolean().optional(),
    ruleLogic: trackerCompletionLogicSchema.optional(),
    ruleThreshold: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .strict()
  .refine((value) => value.ruleLogic !== 'n_of' || value.ruleThreshold != null, {
    message: "ruleThreshold is required when ruleLogic is 'n_of'",
    path: ['ruleThreshold'],
  })
  .refine(
    (value) =>
      value.ruleLogic === undefined || value.ruleLogic === 'n_of' || value.ruleThreshold == null,
    {
      message: "ruleThreshold is only allowed when ruleLogic is 'n_of'",
      path: ['ruleThreshold'],
    },
  );

export type UpdateComponentRequest = z.infer<typeof updateComponentRequestSchema>;

/** `PATCH /campaigns/:id/trackers/:trackerId/order` — TC-21b, drag-to-reorder in one call. */
export const reorderComponentsRequestSchema = z
  .object({
    order: z
      .array(
        z
          .object({
            componentId: z.number().int().positive(),
            sequenceOrder: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export type ReorderComponentsRequest = z.infer<typeof reorderComponentsRequestSchema>;

/** A rule bound to one component, with the dynamic values the maker supplied (step 4). */
export const componentRuleSchema = z
  .object({
    id: z.number().int(),
    ruleId: z.number().int(),
    ruleCode: z.string(),
    ruleName: z.string(),
    /** The pinned version (06-VERSIONING.md §7), or `null` for a rule with no assigned version. */
    ruleVersionId: z.number().int().nullable(),
    ruleVersionNo: z.number().int().nullable(),
    /** The meta-schema the values below were validated against — what the form renders from. */
    parameters: ruleParametersSchema,
    values: z.record(z.unknown()),
    /**
     * T-147 — the comparison contract T-104 added (`tracker_component_rules.operator`/`.value`),
     * sitting next to `values` rather than inside it: `values` is the Maker's own parameter-field
     * input (e.g. `targetComponentCode`), `operator`/`value` are the dedicated comparison the
     * runtime engine reads, matching `tracker-component-rule.model.ts`'s own header on the split.
     * `null` until the Maker sets one — this portal never evaluates rules, so an unset comparison
     * blocks nothing here, only whatever the external engine does with it.
     */
    operator: z.string().nullable(),
    value: z.unknown().nullable(),
    status: z.string(),
  })
  .strict();

export type ComponentRule = z.infer<typeof componentRuleSchema>;

/** One reward attachment, at whichever of the three levels it sits (step 5). */
export const rewardAssignmentSchema = z
  .object({
    id: z.number().int(),
    level: z.enum(['campaign', 'tracker', 'component']),
    /** `tracker_id` / `component_id`; `null` at campaign level. */
    refId: z.number().int().nullable(),
    rewardPolicyId: z.number().int(),
    rewardPolicyName: z.string(),
    rewardId: z.number().int(),
    rewardName: z.string(),
    rewardVersionId: z.number().int().nullable(),
    unitType: z.string().nullable(),
    unitCode: z.string().nullable(),
    /** The per-grant amount when the policy config exposes one; `null` when it does not. */
    amount: z.string().nullable(),
    status: z.string(),
  })
  .strict();

export type RewardAssignment = z.infer<typeof rewardAssignmentSchema>;

export const componentSchema = z
  .object({
    id: z.number().int(),
    linkId: z.number().int(),
    componentCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    activityId: z.number().int().nullable(),
    activityName: z.string().nullable(),
    sequenceOrder: z.number().int(),
    isMandatory: z.boolean(),
    status: z.string(),
    /**
     * T-147 — how this component's own bound rules combine into "is this component complete?",
     * mirroring `trackerSchema`'s `completionLogic`/`completionThreshold` one level up. `null`
     * (never populated, T-104's own default) reads as `'all'` — every existing component keeps
     * behaving exactly as it always has until a Maker explicitly sets one.
     */
    ruleLogic: trackerCompletionLogicSchema.nullable(),
    ruleThreshold: z.number().int().nullable(),
    rules: z.array(componentRuleSchema),
    rewards: z.array(rewardAssignmentSchema),
  })
  .strict();

export type JourneyComponent = z.infer<typeof componentSchema>;

export const trackerSchema = z
  .object({
    id: z.number().int(),
    linkId: z.number().int(),
    trackerCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    completionLogic: trackerCompletionLogicSchema,
    completionThreshold: z.number().int().nullable(),
    isPrimary: z.boolean(),
    status: z.string(),
    components: z.array(componentSchema),
    rewards: z.array(rewardAssignmentSchema),
  })
  .strict();

export type JourneyTracker = z.infer<typeof trackerSchema>;

/** `GET /campaigns/:id/journey` — the whole tree, which is what step 3 and step 5 both render. */
export const journeySchema = z
  .object({
    campaignId: z.number().int(),
    trackers: z.array(trackerSchema),
    campaignRewards: z.array(rewardAssignmentSchema),
  })
  .strict();

export type Journey = z.infer<typeof journeySchema>;

export const journeyEnvelopeSchema = z.object({ data: journeySchema }).strict();

// --- step 4: rule binding -----------------------------------------------------------------------

/**
 * `POST /campaigns/:id/rules` — bind a country-assigned rule to a component and supply its
 * dynamic values (03-API-CONTRACT.md §11).
 *
 * `values` is `unknown`-typed here on purpose: its real shape is only knowable once the rule's
 * own `parameters` meta-schema has been loaded, which both sides then do through
 * {@link buildRuleValueSchema}. Typing it as, say, `Record<string, string | number>` here would
 * be a second, weaker contract that disagrees with the real one.
 */
export const bindComponentRuleRequestSchema = z
  .object({
    componentId: z.number().int().positive(),
    ruleId: z.number().int().positive(),
    values: z.record(z.unknown()).optional(),
  })
  .strict();

export type BindComponentRuleRequest = z.infer<typeof bindComponentRuleRequestSchema>;

/**
 * `PATCH /campaigns/:id/rules/:bindingId` — change the values without re-picking the rule.
 *
 * T-147 — `operator` travels in the same request as `values` rather than its own endpoint: the
 * Maker's UI treats the operator dropdown as part of the same rule-configuration panel `values`
 * already saves as one unit (`ComponentRulesStep.tsx`'s existing dirty/save cycle), and a second
 * endpoint for one more optional field would be a second thing to keep in sync for no benefit.
 * Which operators are actually *allowed* depends on the binding's pinned rule version — runtime
 * state no Zod schema can see — so that check lives in `BindingsService#updateRuleValues`, not
 * here; this schema only checks shape.
 */
export const updateComponentRuleValuesRequestSchema = z
  .object({
    values: z.record(z.unknown()),
    operator: z.string().min(1).max(30).nullable().optional(),
  })
  .strict();

export type UpdateComponentRuleValuesRequest = z.infer<
  typeof updateComponentRuleValuesRequestSchema
>;

/** One row of `GET /campaigns/:id/rule-options` — the rule picker's contents (TC-14). */
export const ruleOptionSchema = z
  .object({
    ruleId: z.number().int(),
    ruleCode: z.string(),
    name: z.string(),
    // T-112/T-138 — every rule has a sub-category (and every sub-category a category), so both
    // ids are non-nullable, unlike the *Name fields above which are best-effort display labels.
    categoryId: z.number().int(),
    subCategoryId: z.number().int(),
    categoryName: z.string().nullable(),
    subCategoryName: z.string().nullable(),
    ruleVersionId: z.number().int().nullable(),
    ruleVersionNo: z.number().int().nullable(),
    parameters: ruleParametersSchema,
    /**
     * T-147 — the pinned version's own `defaultOperators` (T-109/T-110), so the Maker's operator
     * dropdown (`ComponentRulesStep.tsx`) knows what to offer *before* the rule is even bound.
     * Empty for a rule with no assigned version, or a version that never had any set.
     */
    defaultOperators: z.array(z.string()),
  })
  .strict();

export type RuleOption = z.infer<typeof ruleOptionSchema>;

export const ruleOptionListEnvelopeSchema = z.object({ data: z.array(ruleOptionSchema) }).strict();

/** One row of `GET /campaigns/:id/reward-options` — the reward picker's contents (TC-21). */
export const rewardOptionSchema = z
  .object({
    rewardPolicyId: z.number().int(),
    policyCode: z.string(),
    policyName: z.string(),
    rewardId: z.number().int(),
    rewardName: z.string(),
    rewardType: z.string().nullable(),
    rewardVersionId: z.number().int().nullable(),
    unitType: z.string().nullable(),
    unitCode: z.string().nullable(),
    amount: z.string().nullable(),
    /**
     * T-127 — the Kind of the reward's **live** version (`13-REWARD-MASTER-VALUE-SOURCES.md` §5),
     * `null` when that version predates T-119 or the reward has no country-assigned version at
     * all. Step 5 branches on this and nothing else to decide whether the Promo Code Config
     * picker appears: the Kind decides, never the attachment level.
     */
    rewardKind: rewardKindSchema.nullable(),
    /**
     * T-127 — `value_config.bindLevels` for a `PROMO_CODE` reward: the levels its author said it
     * may be attached at. `null` means *no restriction stated* — always the case for every other
     * Kind, and for a `PROMO_CODE` version whose config the server could not parse. Client and
     * server read this the same way (`BindingsService.assertPromoCodeAttachable`), so the picker
     * can never offer an attachment the server would then refuse.
     */
    promoCodeBindLevels: z.array(promoCodeBindLevelSchema).nullable(),
  })
  .strict();

export type RewardOption = z.infer<typeof rewardOptionSchema>;

export const rewardOptionListEnvelopeSchema = z
  .object({ data: z.array(rewardOptionSchema) })
  .strict();

// --- step 5: rewards ----------------------------------------------------------------------------

export const REWARD_LEVELS = ['campaign', 'tracker', 'component'] as const;
export const rewardLevelSchema = z.enum(REWARD_LEVELS);
export type RewardLevel = z.infer<typeof rewardLevelSchema>;

/**
 * `POST /campaigns/:id/rewards`. All three levels may be populated at once (implementation
 * note 10, TC-21n) — the step-5 tree shows every attachment point, including the empty ones.
 */
export const attachRewardRequestSchema = z
  .object({
    level: rewardLevelSchema,
    /** Required for `tracker`/`component`, forbidden for `campaign` — mirrors `ck_cc_ref`. */
    refId: z.number().int().positive().optional(),
    rewardPolicyId: z.number().int().positive(),
    /**
     * T-127 — the Promo Code Config the maker picked, for a `PROMO_CODE` reward only
     * (`13-REWARD-MASTER-VALUE-SOURCES.md` §5). Optional and **absent**, never `null`, when
     * nothing was picked: today `PROMO_CODE_CONFIG_SERVICE` is `planned`, so there is nothing to
     * pick and attaching without one is the normal path, not a validation failure.
     *
     * An opaque identifier issued by a service that does not exist yet, so the only shape this
     * boundary can honestly assert is "a non-empty, bounded string". What it must *be* — that it
     * names a config the provider actually knows — is not checkable until that provider is built;
     * the server additionally rejects it outright on a reward that is not `PROMO_CODE`, which is
     * checkable today.
     */
    promoCodeConfig: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => (value.level === 'campaign') === (value.refId === undefined), {
    message: 'refId is required for tracker/component level and forbidden at campaign level',
    path: ['refId'],
  });

export type AttachRewardRequest = z.infer<typeof attachRewardRequestSchema>;

/** The worst-case payout line step 5 shows (implementation note 10). One entry per reward unit,
 * because a MYR total and a PTS total are not addable — 11-BUDGETS-AND-LIMITS.md §3.1. */
export const worstCasePayoutLineSchema = z
  .object({
    unitType: z.string().nullable(),
    unitCode: z.string().nullable(),
    /** Sum of the known per-grant amounts across every attachment in this unit. */
    perCustomerAmount: z.string(),
    attachmentCount: z.number().int(),
    /** True when at least one attachment's policy exposes no amount, so the sum is a floor. */
    hasUnknownAmounts: z.boolean(),
  })
  .strict();

export type WorstCasePayoutLine = z.infer<typeof worstCasePayoutLineSchema>;

// --- step 6: budgets and limits -----------------------------------------------------------------

export const CAP_CLASSES = ['budget', 'limit'] as const;
export const capClassSchema = z.enum(CAP_CLASSES);
export type CapClass = z.infer<typeof capClassSchema>;

export const CAP_SCOPE_LEVELS = ['campaign', 'tracker', 'component'] as const;
export const capScopeLevelSchema = z.enum(CAP_SCOPE_LEVELS);
export type CapScopeLevel = z.infer<typeof capScopeLevelSchema>;

export const CAP_PERIOD_TYPES = [
  'lifetime',
  'daily',
  'monthly',
  'rolling_hours',
  'time_of_day',
] as const;
export const capPeriodTypeSchema = z.enum(CAP_PERIOD_TYPES);
export type CapPeriodType = z.infer<typeof capPeriodTypeSchema>;

export const CAP_UNIT_TYPES = ['currency', 'points', 'voucher'] as const;
export const capUnitTypeSchema = z.enum(CAP_UNIT_TYPES);
export type CapUnitType = z.infer<typeof capUnitTypeSchema>;

export const CAP_ON_BREACH = ['reject', 'pause_campaign', 'alert_only'] as const;
export const capOnBreachSchema = z.enum(CAP_ON_BREACH);
export type CapOnBreach = z.infer<typeof capOnBreachSchema>;

/**
 * One `campaign_caps` row as the wizard sends it.
 *
 * Every `.refine` below mirrors a **database CHECK constraint** of the same name (T006_001), on
 * purpose and not as a substitute: the database is authoritative, and these exist so the maker
 * sees the problem next to the field rather than as a 500 from a constraint violation. The
 * server re-parses the identical schema, so a client that skips this gets the same 400.
 */
export const campaignCapInputSchema = z
  .object({
    capClass: capClassSchema,
    scopeLevel: capScopeLevelSchema,
    scopeRefId: z.number().int().positive().nullable().optional(),
    periodType: capPeriodTypeSchema,
    periodValue: z.number().int().min(1).max(87_600).nullable().optional(),
    windowStartTime: timeOfDaySchema.nullable().optional(),
    windowEndTime: timeOfDaySchema.nullable().optional(),
    periodTimezone: z.string().max(60).nullable().optional(),
    unitType: capUnitTypeSchema.nullable().optional(),
    unitCode: unitCodeSchema.nullable().optional(),
    rewardType: z.string().max(30).nullable().optional(),
    maxTotalAmount: moneySchema.nullable().optional(),
    maxOccurrences: z.number().int().min(1).max(1_000_000).nullable().optional(),
    maxCustomers: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
    onBreach: capOnBreachSchema.optional(),
    warnAtPercent: z.number().int().min(1).max(99).nullable().optional(),
  })
  .strict()
  // ck_cc_ref
  .refine(
    (cap) =>
      cap.scopeLevel === 'campaign'
        ? cap.scopeRefId === null || cap.scopeRefId === undefined
        : typeof cap.scopeRefId === 'number',
    {
      message: 'scopeRefId is required for tracker/component scope and forbidden at campaign scope',
      path: ['scopeRefId'],
    },
  )
  // ck_cc_has_ceiling — "a cap that caps nothing is a configuration error, not a valid row"
  .refine(
    (cap) => isSet(cap.maxTotalAmount) || isSet(cap.maxOccurrences) || isSet(cap.maxCustomers),
    {
      message: 'a cap must set at least one of maxTotalAmount, maxOccurrences or maxCustomers',
      path: ['maxTotalAmount'],
    },
  )
  // ck_cc_unit — TC-21w, "budget amount with no currency": client and server both reject
  .refine((cap) => !isSet(cap.maxTotalAmount) || (isSet(cap.unitType) && isSet(cap.unitCode)), {
    message: 'an amount cap must carry unitType and unitCode',
    path: ['unitCode'],
  })
  // ck_cc_customers — "distinct participants" is a pooled idea; meaningless per customer
  .refine((cap) => !isSet(cap.maxCustomers) || cap.capClass === 'budget', {
    message: 'maxCustomers applies to a budget, not a per-customer limit',
    path: ['maxCustomers'],
  })
  // ck_cc_rolling
  .refine((cap) => cap.periodType !== 'rolling_hours' || isSet(cap.periodValue), {
    message: 'rolling_hours requires periodValue',
    path: ['periodValue'],
  })
  // ck_cc_window
  .refine(
    (cap) =>
      cap.periodType !== 'time_of_day' || (isSet(cap.windowStartTime) && isSet(cap.windowEndTime)),
    {
      message: 'time_of_day requires windowStartTime and windowEndTime',
      path: ['windowStartTime'],
    },
  );

export type CampaignCapInput = z.infer<typeof campaignCapInputSchema>;

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * `PUT /campaigns/:id/caps` — the whole cap set, replaced atomically.
 *
 * `confirmCurrencyMismatch` is TC-21bb: a cap denominated in a currency other than the
 * campaign's own is legitimate but is almost always a mistake, so it needs one deliberate
 * acknowledgement rather than a silent accept.
 */
export const putCampaignCapsRequestSchema = z
  .object({
    caps: z.array(campaignCapInputSchema).max(100),
    confirmCurrencyMismatch: z.boolean().optional(),
  })
  .strict();

export type PutCampaignCapsRequest = z.infer<typeof putCampaignCapsRequestSchema>;

/** One stored `campaign_caps` row on the way back out. */
export const campaignCapSchema = z
  .object({
    id: z.number().int(),
    capClass: capClassSchema,
    scopeLevel: capScopeLevelSchema,
    scopeRefId: z.number().int().nullable(),
    periodType: capPeriodTypeSchema,
    periodValue: z.number().int().nullable(),
    windowStartTime: z.string().nullable(),
    windowEndTime: z.string().nullable(),
    periodTimezone: z.string().nullable(),
    unitType: z.string().nullable(),
    unitCode: z.string().nullable(),
    rewardType: z.string().nullable(),
    maxTotalAmount: z.string().nullable(),
    maxOccurrences: z.number().int().nullable(),
    maxCustomers: z.number().int().nullable(),
    onBreach: capOnBreachSchema,
    warnAtPercent: z.number().int().nullable(),
    status: z.string(),
  })
  .strict();

export type CampaignCapRow = z.infer<typeof campaignCapSchema>;

/**
 * One live sanity check from step 6 (implementation notes 15/16) or one ceiling notice
 * (note 17). Always a **warning**, never a block — the only hard stop is
 * `BUDGET_EXCEEDS_TENANT_CEILING` at submit, which is an error rather than one of these.
 */
export const CAMPAIGN_WARNING_CODES = [
  /** Tracker budgets sum above the campaign budget for their unit (note 15, TC-21x). */
  'TRACKER_BUDGETS_EXCEED_CAMPAIGN',
  /** A per-customer daily limit above the campaign's daily budget (note 15, TC-21y). */
  'CUSTOMER_LIMIT_EXCEEDS_DAILY_BUDGET',
  /** daily limit x campaign days < the per-customer campaign limit (note 15). */
  'CUSTOMER_CAMPAIGN_LIMIT_UNREACHABLE',
  /** A reward whose unit has no matching budget — it will be uncapped (note 16, TC-21dd). */
  'REWARD_UNIT_HAS_NO_BUDGET',
  /** Between `warn_above_amount` and `max_campaign_budget` (note 17, TC-21hh). */
  'BUDGET_NEAR_TENANT_CEILING',
  /** Above `max_campaign_budget`. Submission will be refused with a 422. */
  'BUDGET_ABOVE_TENANT_CEILING',
  /** A cap denominated in a currency other than the campaign's (TC-21bb). */
  'CAP_CURRENCY_DIFFERS_FROM_CAMPAIGN',
] as const;
export const campaignWarningCodeSchema = z.enum(CAMPAIGN_WARNING_CODES);
export type CampaignWarningCode = z.infer<typeof campaignWarningCodeSchema>;

export const campaignWarningSchema = z
  .object({
    code: campaignWarningCodeSchema,
    /** Which unit the warning concerns, when it concerns one. */
    unitType: z.string().nullable(),
    unitCode: z.string().nullable(),
    /** Free-form, machine-readable context. Rendered by the SPA, never interpolated into SQL. */
    detail: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

export type CampaignWarning = z.infer<typeof campaignWarningSchema>;

/** One unit's tenant-ceiling picture (note 17) — shown live as the maker types. */
export const budgetCeilingStatusSchema = z
  .object({
    unitType: z.string(),
    unitCode: z.string(),
    /** The campaign's own lifetime budget in this unit. */
    campaignBudget: z.string(),
    /** `null` when the tenant has no ceiling row for this unit — unlimited, not blocked (§8.5). */
    maxCampaignBudget: z.string().nullable(),
    warnAboveAmount: z.string().nullable(),
    /** `maxCampaignBudget - campaignBudget`, or `null` when unlimited. */
    headroom: z.string().nullable(),
    /** Integer percent of the ceiling, or `null` when unlimited. Carried into the approval
     * payload so a checker sees an unusual number without doing arithmetic (note 18). */
    percentOfCeiling: z.number().nullable(),
    state: z.enum(['unlimited', 'ok', 'warn', 'over']),
  })
  .strict();

export type BudgetCeilingStatus = z.infer<typeof budgetCeilingStatusSchema>;

export const campaignCapsResponseSchema = z
  .object({
    caps: z.array(campaignCapSchema),
    warnings: z.array(campaignWarningSchema),
    ceilings: z.array(budgetCeilingStatusSchema),
    worstCasePayout: z.array(worstCasePayoutLineSchema),
  })
  .strict();

export type CampaignCapsResponse = z.infer<typeof campaignCapsResponseSchema>;

export const campaignCapsEnvelopeSchema = z.object({ data: campaignCapsResponseSchema }).strict();

// --- step 7: review and submit ------------------------------------------------------------------

/** One structural problem that blocks submission (implementation note 19). */
export const structuralIssueSchema = z
  .object({
    code: z.enum([
      'TRACKER_HAS_NO_COMPONENT',
      'COMPONENT_HAS_NO_ACTIVITY',
      'COMPONENT_HAS_NO_RULE',
      'THRESHOLD_ABOVE_COMPONENT_COUNT',
      'RULE_VALUES_INCOMPLETE',
      'CAMPAIGN_HAS_NO_REWARD',
      'CAMPAIGN_HAS_NO_TRACKER',
      'CAMPAIGN_HAS_NO_MERCHANT',
    ]),
    trackerId: z.number().int().nullable(),
    componentId: z.number().int().nullable(),
  })
  .strict();

export type StructuralIssue = z.infer<typeof structuralIssueSchema>;

/** `GET /campaigns/:id/review` — everything step 7 renders before the maker commits. */
export const campaignReviewSchema = z
  .object({
    campaign: campaignSchema,
    merchants: z.array(campaignMerchantSchema),
    journey: journeySchema,
    caps: z.array(campaignCapSchema),
    warnings: z.array(campaignWarningSchema),
    ceilings: z.array(budgetCeilingStatusSchema),
    worstCasePayout: z.array(worstCasePayoutLineSchema),
    issues: z.array(structuralIssueSchema),
    /** False whenever `issues` is non-empty or a ceiling is `over`. The button state. */
    submittable: z.boolean(),
  })
  .strict();

export type CampaignReview = z.infer<typeof campaignReviewSchema>;

export const campaignReviewEnvelopeSchema = z.object({ data: campaignReviewSchema }).strict();

/** `POST /campaigns/:id/submit` — no body. Declared so the SPA sends `{}` and the server's
 * `forbidNonWhitelisted` pipe has something to accept. */
export const submitCampaignRequestSchema = z.object({}).strict();

export const submitCampaignResponseSchema = z
  .object({
    campaign: campaignSchema,
    approvalRequestId: z.number().int(),
    expiresAt: z.string(),
  })
  .strict();

export type SubmitCampaignResponse = z.infer<typeof submitCampaignResponseSchema>;

export const submitCampaignEnvelopeSchema = z
  .object({ data: submitCampaignResponseSchema })
  .strict();

/** One `campaign_audit_trail` row — `GET /campaigns/:id/audit` (03-API-CONTRACT.md §11). */
export const campaignAuditEntrySchema = z
  .object({
    id: z.number().int(),
    entityType: z.string(),
    entityId: z.number().int().nullable(),
    action: z.string(),
    fieldChanges: z.record(z.unknown()).nullable(),
    performedBy: z.number().int(),
    performedByName: z.string().nullable(),
    performedAt: z.string(),
    comment: z.string().nullable(),
  })
  .strict();

export type CampaignAuditEntry = z.infer<typeof campaignAuditEntrySchema>;

export const campaignAuditListEnvelopeSchema = z
  .object({ data: z.array(campaignAuditEntrySchema), meta: campaignListMetaSchema })
  .strict();

// --- the dynamic-value schema builder -----------------------------------------------------------

/**
 * Builds the Zod schema a maker's supplied values for one rule must satisfy.
 *
 * Consumed by `DynamicParameterForm` (client, for the form resolver) and by the campaign service
 * (server, re-validating the same bytes) — see this file's header for why there is exactly one
 * implementation.
 *
 * Three properties are deliberate:
 *
 *  - **`.strict()`** — an extra key that is not in the rule's `parameters` is a 400 (TC-19), not
 *    a silently stored value. A value nothing will ever read is worse than a rejection: it looks
 *    like configuration and behaves like nothing.
 *  - **Optional means "may be omitted", not "may be null".** A required field absent → 400
 *    (TC-18). An optional field present-but-empty is normalised away by the caller before it
 *    reaches here, so `undefined` is the only representation of "not supplied".
 *  - **`min`/`max` are applied to `number` fields only**, exactly as `ruleParameterFieldSchema`
 *    documents them, so TC-17's out-of-range value fails on the server whatever the client did.
 *
 * A fourth property, added by T-136: a `select` field whose choices come from a **provider**
 * rather than from a hand-typed `options` array is validated for *shape*, not for membership —
 * see {@link selectFieldSchema} for why membership is not this function's question to answer.
 */
export function buildRuleValueSchema(
  parameters: RuleParameters,
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of parameters.fields) {
    shape[field.key] = field.required ? fieldSchema(field) : fieldSchema(field).optional();
  }

  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}

/**
 * The single member of the `z.enum` used when a `select` field somehow has no options — a value no
 * maker can submit, so the enum accepts nothing and the field fails closed.
 *
 * It leads with a NUL because a NUL cannot survive a JSON request body, which is what makes this
 * genuinely unmatchable rather than merely unlikely.
 *
 * Built with `String.fromCharCode(0)` and **never written as a literal NUL byte** (T-065, found
 * while tracing the campaign-date contract). An earlier version of this line embedded the raw
 * byte, which made `file(1)` report this entire module as `data` rather than text and made `grep`
 * skip all 1300 lines of it **silently** — a repository-wide search for anything in this contract
 * matched nothing, with no error and no warning to say the file had been skipped. The call
 * produces exactly the same string at runtime and keeps the file greppable.
 */
const NO_OPTIONS_SENTINEL = `${String.fromCharCode(0)}__no_options__`;

/**
 * The longest a free-text value may be, and — see {@link selectFieldSchema} — the longest a
 * provider-sourced `select` value may be. Named rather than repeated so the two cannot drift:
 * both are "a string this function cannot enumerate", and length is the only honest bound it has.
 */
const STRING_VALUE_MAX_LENGTH = 2000;

/**
 * T-136 — the value schema for one `select` field, which has two genuinely different sources
 * (`13-REWARD-MASTER-VALUE-SOURCES.md` §3, T-122) and therefore two different contracts:
 *
 *  - **A `valueSource` is declared.** The choices are produced at campaign time by a registered
 *    context/API provider (`GET /field-value-sources/context|api/:code`, T-123). They are not
 *    knowable to this function — it is pure, synchronous, runs identically in a browser and in
 *    the API process, and has no registry, no tracker and no campaign draft to read. So it checks
 *    the **shape** of the value and leaves membership to the layers that can actually answer it:
 *    T-123's own lookup decides what the Maker is offered, and the binding save path is where a
 *    stale or forged choice is re-checked against the journey (T-124's `SIBLING_COMPONENTS`
 *    guard). This is the T-136 fix. Before it, this branch enumerated `options` for *every*
 *    `select`, so a field with a `valueSource` and no `options` — legal since T-122, and the
 *    normal case for a provider-backed field — became an enum of one unmatchable sentinel that
 *    rejected every value a Maker could possibly pick, client-side *and* server-side, from the
 *    same shared function.
 *  - **No `valueSource`.** The hand-typed `options` array is the entire contract and is enforced
 *    exactly as before; a value outside it is a 400 on both sides. Unchanged by T-136.
 *
 * A field carrying **both** takes the provider branch. `ruleParameterFieldSchema` permits the
 * combination and T-125 renders such a field from its provider (`ComponentRulesStep.tsx` routes
 * on `valueSource !== undefined`), so validating it against the unrendered `options` list would
 * reject precisely the values the Maker was shown.
 *
 * A provider's own `value` is `string | number` (`FieldValueOption`, both in T-123's lookup
 * service and in the SPA's `ruleValues.ts`), so both arrive here — a number is **normalised to
 * its string form** rather than stored as-is. The SPA already sends `String(option.value)`; an
 * API or agent caller that forwards the provider's raw `4321` must not produce a second stored
 * representation of the one value a later reader (T-124's guard, the rules engine) has to
 * compare. One value, one shape in `tracker_component_rules.config`.
 */
function selectFieldSchema(field: RuleParameterField): z.ZodTypeAny {
  if (field.valueSource !== undefined) {
    return z
      .union([z.string().min(1).max(STRING_VALUE_MAX_LENGTH), z.number().finite()])
      .transform((value) => String(value));
  }

  // `field.options` is guaranteed non-empty by `ruleParameterFieldSchema`'s own refine, but
  // this function is called with data that came out of the database, where a row written
  // before that refine existed could still be malformed. Falling back to "no value is
  // acceptable" fails closed; throwing here would 500 a maker's form instead.
  return z.enum((field.options ?? [NO_OPTIONS_SENTINEL]) as [string, ...string[]]);
}

function fieldSchema(field: RuleParameterField): z.ZodTypeAny {
  switch (field.type) {
    case 'number': {
      let schema = z.number().finite();
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      return schema;
    }
    case 'boolean':
      return z.boolean();
    case 'date':
      // A calendar date, not an instant: a rule parameter like "promotion starts" is a day, and
      // an instant here would reintroduce exactly the offset ambiguity `isoDateTimeSchema`
      // exists to remove for the campaign's own dates.
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');
    case 'select':
      return selectFieldSchema(field);
    case 'string':
    default:
      return z.string().min(1).max(STRING_VALUE_MAX_LENGTH);
  }
}

/**
 * Which required parameter keys a stored value blob is missing.
 *
 * Used by the pre-submit structural check (implementation note 19: *"every rule has all required
 * parameter values"*), where a **list** of what is missing is more useful than a thrown error —
 * step 7 shows the maker every problem at once rather than one per round trip.
 */
export function missingRequiredParameterKeys(
  parameters: RuleParameters,
  values: Record<string, unknown>,
): readonly string[] {
  return parameters.fields
    .filter((field) => field.required && values[field.key] === undefined)
    .map((field) => field.key);
}

// --- T-048: the AI campaign agent (10-AI-CAMPAIGN-AGENT.md) ---------------------------------------

/**
 * The agent's wire contract lives in **this** file rather than in an `agent.schema.ts` of its own,
 * for the reason 05-EXECUTION-PLAN.md §3 gives for one-file-per-domain: the agent is not a second
 * domain, it is a second *way of authoring the same campaign*. Every type below either names a
 * campaign concept already defined above ({@link campaignCapInputSchema},
 * {@link trackerCompletionLogicSchema}) or is a view of one, and splitting them across two files
 * would let the two drift in exactly the direction §1 of the design doc forbids — *"a bug in the
 * agent cannot produce a campaign a human maker could not have produced by hand"* is only true
 * while both describe the same shape.
 */

/** `agent_sessions.state` — `ck_as_state`, verbatim. */
export const AGENT_SESSION_STATES = [
  /** Filling slots. The state a session spends almost all its life in. */
  'collecting',
  /** A plan has been built and hashed; the maker is looking at it (10-AI §3.2). */
  'reviewing',
  /** The draft campaign exists. Terminal — the agent never re-enters a created session. */
  'created',
  'abandoned',
  'error',
] as const;
export const agentSessionStateSchema = z.enum(AGENT_SESSION_STATES);
export type AgentSessionState = z.infer<typeof agentSessionStateSchema>;

/** The two archetypes ported from `agents/create-campaign-v2` (10-AI §1). */
export const AGENT_ARCHETYPES = ['instant_reward', 'deferred_reward'] as const;
export const agentArchetypeSchema = z.enum(AGENT_ARCHETYPES);
export type AgentArchetype = z.infer<typeof agentArchetypeSchema>;

/**
 * One choice the agent offered this turn (10-AI §3.1).
 *
 * `optionId` is an **opaque token**, never a database id the model could have invented: it is
 * minted by Zone 2 when a tool resolves a row through `ScopedRepository`, recorded against the
 * session, and re-resolved against the maker's scope before use. The model may reference it; it
 * cannot construct one that resolves.
 */
export const agentOptionSchema = z
  .object({
    optionId: z.string().min(1).max(40),
    label: z.string(),
    subtitle: z.string().nullable(),
  })
  .strict();

export type AgentOption = z.infer<typeof agentOptionSchema>;

/** The four option kinds a turn can offer, keyed by the conversation step that offers them. */
export const agentOptionsSchema = z
  .object({
    merchants: z.array(agentOptionSchema),
    activities: z.array(agentOptionSchema),
    rules: z.array(agentOptionSchema),
    rewards: z.array(agentOptionSchema),
  })
  .strict();

export type AgentOptions = z.infer<typeof agentOptionsSchema>;

/** One rule the maker picked, with the dynamic values supplied for it (10-AI §4 steps 5–6). */
export const agentPlanRuleSchema = z
  .object({
    ruleId: z.number().int(),
    ruleCode: z.string(),
    ruleName: z.string(),
    ruleVersionId: z.number().int().nullable(),
    ruleVersionNo: z.number().int().nullable(),
    values: z.record(z.unknown()),
  })
  .strict();

export type AgentPlanRule = z.infer<typeof agentPlanRuleSchema>;

/** One component of the planned journey — one chosen activity, and the rules that complete it. */
export const agentPlanComponentSchema = z
  .object({
    name: z.string(),
    activityId: z.number().int(),
    activityName: z.string(),
    rules: z.array(agentPlanRuleSchema),
  })
  .strict();

export type AgentPlanComponent = z.infer<typeof agentPlanComponentSchema>;

/**
 * One reward attachment in the plan.
 *
 * `componentIndex` rather than a component id, because the components do not exist yet — the plan
 * is what will be built, not a description of something already built.
 */
export const agentPlanRewardSchema = z
  .object({
    level: rewardLevelSchema,
    componentIndex: z.number().int().min(0).nullable(),
    rewardPolicyId: z.number().int(),
    policyName: z.string(),
  })
  .strict();

export type AgentPlanReward = z.infer<typeof agentPlanRewardSchema>;

/**
 * The complete plan, exactly as it is hashed and exactly as it is executed (10-AI §3.2).
 *
 * Two properties matter more than the field list:
 *
 *  1. **It is the whole input to execution.** `portal-api.client.ts` reads nothing else — no slot,
 *     no session field, no request body. So "the thing approved is the thing executed" is a
 *     statement about one object rather than about a code path.
 *  2. **It carries labels as well as ids.** They are what the maker actually read, so they are
 *     part of what was approved and therefore part of the hash. A merchant renamed between review
 *     and confirm changes the hash and forces a re-review — which is the correct outcome, not an
 *     inconvenience: the summary the maker approved no longer describes what would be built.
 */
export const agentPlanSchema = z
  .object({
    archetype: agentArchetypeSchema,
    campaign: z
      .object({
        campaignCode: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        /** Calendar dates, like every other campaign date (T-065). The plan is what the maker
         * reads and what is hashed, so it carries the same day they will see in the wizard. */
        startDate: calendarDateSchema,
        endDate: calendarDateSchema,
        budgetAmount: z.string().nullable(),
        budgetCurrency: z.string().nullable(),
      })
      .strict(),
    merchants: z
      .array(z.object({ merchantId: z.number().int(), name: z.string() }).strict())
      .min(1),
    tracker: z
      .object({
        name: z.string(),
        completionLogic: trackerCompletionLogicSchema,
        completionThreshold: z.number().int().nullable(),
      })
      .strict(),
    components: z.array(agentPlanComponentSchema).min(1),
    rewards: z.array(agentPlanRewardSchema).min(1),
    caps: z.array(campaignCapInputSchema),
  })
  .strict();

export type AgentPlan = z.infer<typeof agentPlanSchema>;

/** The session header the chat UI renders around the transcript. */
export const agentSessionSchema = z
  .object({
    sessionId: z.string(),
    state: agentSessionStateSchema,
    archetype: agentArchetypeSchema.nullable(),
    /** Present from the moment a plan is built; `null` while still collecting. */
    planHash: z.string().nullable(),
    /** Set only in `created` — `ck_as_campaign` makes the two agree in the database too. */
    campaignId: z.number().int().nullable(),
    campaignCode: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type AgentSession = z.infer<typeof agentSessionSchema>;

/** One turn of the persisted, append-only transcript (10-AI §7, TC-22). */
export const agentEventSchema = z
  .object({
    seq: z.number().int(),
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string().nullable(),
    at: z.string(),
  })
  .strict();

export type AgentEvent = z.infer<typeof agentEventSchema>;

/** What the maker still has to decide, so the UI can show progress without re-deriving it. */
export const agentProgressSchema = z
  .object({
    /** Machine-readable slot keys still empty, in the order the agent will ask for them. */
    missing: z.array(z.string()),
    /** The one thing the agent is asking about right now. */
    nextStep: z.string(),
    complete: z.boolean(),
    /** True once §9's stall rule has fired — the UI then surfaces the wizard link. */
    offerWizard: z.boolean(),
  })
  .strict();

export type AgentProgress = z.infer<typeof agentProgressSchema>;

/** `POST /campaign-agent/sessions/:id/messages`. */
export const sendAgentMessageRequestSchema = z
  .object({ message: z.string().min(1).max(4000) })
  .strict();

export type SendAgentMessageRequest = z.infer<typeof sendAgentMessageRequestSchema>;

/**
 * `POST /campaign-agent/sessions/:id/confirm` — the click that creates the campaign.
 *
 * The hash is the *whole* body, and it is the whole authorisation: Zone 2 rebuilds the plan from
 * the stored slots, recomputes the hash, and refuses on mismatch (TC-14/TC-15).
 */
export const confirmAgentPlanRequestSchema = z
  .object({ planHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

export type ConfirmAgentPlanRequest = z.infer<typeof confirmAgentPlanRequestSchema>;

/** One conversational turn's full response. */
export const agentTurnSchema = z
  .object({
    session: agentSessionSchema,
    /** The assistant's reply, as plain text. **Never HTML** — see T-049's renderer. */
    reply: z.string(),
    options: agentOptionsSchema,
    progress: agentProgressSchema,
    /** Present once the plan has been built and is awaiting the maker's confirmation. */
    plan: agentPlanSchema.nullable(),
  })
  .strict();

export type AgentTurn = z.infer<typeof agentTurnSchema>;

export const agentTurnEnvelopeSchema = z.object({ data: agentTurnSchema }).strict();

/** `GET /campaign-agent/sessions/:id` — resume (TC-21), transcript included (TC-22). */
export const agentSessionDetailSchema = z
  .object({
    session: agentSessionSchema,
    events: z.array(agentEventSchema),
    options: agentOptionsSchema,
    progress: agentProgressSchema,
    plan: agentPlanSchema.nullable(),
  })
  .strict();

export type AgentSessionDetail = z.infer<typeof agentSessionDetailSchema>;

export const agentSessionDetailEnvelopeSchema = z
  .object({ data: agentSessionDetailSchema })
  .strict();

export const agentSessionListEnvelopeSchema = z
  .object({ data: z.array(agentSessionSchema) })
  .strict();

/** `POST /campaign-agent/sessions/:id/confirm` — the hand-off (10-AI §4 step 11). */
export const agentCreatedCampaignSchema = z
  .object({
    session: agentSessionSchema,
    campaign: campaignSchema,
    /**
     * Always `draft`, always. *"The agent stops at `draft`. It never calls `/submit`."* — declared
     * on the wire so a client that assumed otherwise fails its own contract test.
     */
    handOff: z
      .object({
        message: z.string(),
        wizardPath: z.string(),
      })
      .strict(),
  })
  .strict();

export type AgentCreatedCampaign = z.infer<typeof agentCreatedCampaignSchema>;

export const agentCreatedCampaignEnvelopeSchema = z
  .object({ data: agentCreatedCampaignSchema })
  .strict();
