/**
 * T-048 — the slot store and the state machine over it (10-AI-CAMPAIGN-AGENT.md §4).
 *
 * ### Slot-filling, not free-form
 *
 * §4 is explicit: *"Slot-filling, not free-form. The agent's job is to reach a complete, valid
 * campaign with the fewest questions — and to make every choice a selection from real master data
 * rather than free text."* This file is where "complete" is defined, once, as data. The
 * orchestrator asks {@link nextStep} what to talk about; the policy engine and the plan builder
 * both refuse to proceed while {@link missingSlots} is non-empty. There is no second opinion about
 * what a finished campaign looks like, and in particular the model never holds one.
 *
 * ### Every reference is an `optionId`, never an id
 *
 * `merchants`, `activities`, `rules[].ruleOptionId` and `rewards[].rewardOptionId` all hold the
 * opaque tokens `option-resolver.service.ts` mints. Nothing in this file resolves them, and
 * nothing in this file can: the slot store is deliberately a record of *choices*, and the mapping
 * from a choice to a row is re-done against the maker's live scope every time it is needed
 * (§3.1). Storing resolved ids here would make the session a cache of authorisation decisions,
 * and a cache of authorisation decisions goes stale in the one direction that matters.
 *
 * ### Why the slots are not a Zod schema of the campaign
 *
 * A partially-filled campaign is not a campaign, and modelling it as "the campaign schema with
 * everything optional" produces a type that says nothing. These are the *questions*, in the order
 * §4 asks them; `plan-hash.service.ts` is what turns a complete set of answers into something the
 * campaign schema recognises.
 */
import { z } from 'zod';
import {
  AGENT_ARCHETYPES,
  TRACKER_COMPLETION_LOGICS,
  campaignCapInputSchema,
} from '@reward-portal/shared';

/** One rule the maker chose, and the dynamic values supplied for it (§4 steps 5–6). */
export const slotRuleSchema = z
  .object({
    /** Which component (i.e. which chosen activity) this rule completes. */
    activityOptionId: z.string(),
    ruleOptionId: z.string(),
    values: z.record(z.unknown()),
  })
  .strict();

export type SlotRule = z.infer<typeof slotRuleSchema>;

/** One reward attachment the maker chose (§4 step 7). */
export const slotRewardSchema = z
  .object({
    rewardOptionId: z.string(),
    level: z.enum(['campaign', 'tracker', 'component']),
    /** Required at `component` level, absent otherwise. Mirrors `attachRewardRequestSchema`. */
    activityOptionId: z.string().nullable(),
  })
  .strict();

export type SlotReward = z.infer<typeof slotRewardSchema>;

/**
 * The whole slot store, as persisted in `agent_sessions.slots`.
 *
 * Parsed on read as well as written on write: the column is `jsonb`, so a row written by an older
 * build is data of unknown shape until it has been through this schema. `.strict()` means an
 * unexpected key fails loudly at load rather than being silently carried into a plan.
 */
export const agentSlotsSchema = z
  .object({
    archetype: z.enum(AGENT_ARCHETYPES).nullable(),
    name: z.string().min(1).max(200).nullable(),
    campaignCode: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/)
      .nullable(),
    description: z.string().max(4000).nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    budgetAmount: z.string().nullable(),
    budgetCurrency: z.string().nullable(),
    merchants: z.array(z.string()),
    activities: z.array(z.string()),
    trackerName: z.string().min(1).max(200).nullable(),
    completionLogic: z.enum(TRACKER_COMPLETION_LOGICS).nullable(),
    completionThreshold: z.number().int().min(1).max(1000).nullable(),
    rules: z.array(slotRuleSchema),
    rewards: z.array(slotRewardSchema),
    caps: z.array(campaignCapInputSchema),
  })
  .strict();

export type AgentSlots = z.infer<typeof agentSlotsSchema>;

/** A brand-new, entirely empty slot store. */
export function emptySlots(): AgentSlots {
  return {
    archetype: null,
    name: null,
    campaignCode: null,
    description: null,
    startDate: null,
    endDate: null,
    budgetAmount: null,
    budgetCurrency: null,
    merchants: [],
    activities: [],
    trackerName: null,
    completionLogic: null,
    completionThreshold: null,
    rules: [],
    rewards: [],
    caps: [],
  };
}

/**
 * The patch shape the **model** may propose.
 *
 * It is a strict subset of the slot store and that is the point: there is no key here for
 * `tenantId`, for a campaign id, for a status, or for anything else the model has no business
 * choosing. `.strict()` turns an attempt to set one into a rejected turn rather than an ignored
 * key, so a prompt injection that invents `{"tenantId": 9}` fails visibly (TC-10, TC-11).
 *
 * Every field is optional because a turn typically fills one or two.
 */
export const slotPatchSchema = z
  .object({
    archetype: z.enum(AGENT_ARCHETYPES).optional(),
    name: z.string().min(1).max(200).optional(),
    campaignCode: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/)
      .optional(),
    description: z.string().max(4000).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    budgetAmount: z.string().optional(),
    budgetCurrency: z.string().optional(),
    merchants: z.array(z.string()).max(200).optional(),
    activities: z.array(z.string()).max(200).optional(),
    trackerName: z.string().min(1).max(200).optional(),
    completionLogic: z.enum(TRACKER_COMPLETION_LOGICS).optional(),
    completionThreshold: z.number().int().min(1).max(1000).optional(),
    rules: z.array(slotRuleSchema).max(100).optional(),
    rewards: z.array(slotRewardSchema).max(100).optional(),
    caps: z.array(campaignCapInputSchema).max(100).optional(),
  })
  .strict();

export type SlotPatch = z.infer<typeof slotPatchSchema>;

/** Applies a validated patch. Pure — the caller decides whether to persist the result. */
export function applySlotPatch(slots: AgentSlots, patch: SlotPatch): AgentSlots {
  return {
    ...slots,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  } as AgentSlots;
}

/**
 * The conversation's steps, in the order §4 walks them.
 *
 * Ordered, and the order is load-bearing rather than cosmetic: activities can only be offered once
 * merchants are chosen (they are derived from `merchant_activities`), and rule *values* can only
 * be asked for once the rule — and therefore its parameter schema — is known. Asking out of order
 * would mean asking a question whose options do not exist yet.
 */
export const SLOT_STEPS = [
  'archetype',
  'name',
  'campaignCode',
  'startDate',
  'endDate',
  'budget',
  'merchants',
  'activities',
  'tracker',
  'rules',
  'ruleValues',
  'rewards',
] as const;

export type SlotStep = (typeof SLOT_STEPS)[number];

/** Human-readable prompts, one per step — what the agent is trying to find out. */
const STEP_PROMPT: Readonly<Record<SlotStep, string>> = Object.freeze({
  archetype: 'What should this campaign do — reward instantly, or after a waiting period?',
  name: 'What should this campaign be called?',
  campaignCode: 'What short code should identify this campaign?',
  startDate: 'When does the campaign start?',
  endDate: 'When does it end?',
  budget: 'What is the campaign budget, and in which currency?',
  merchants: 'Which merchants take part?',
  activities: 'Which merchant activities does the campaign track?',
  tracker: 'What should the tracker be called, and how does it complete?',
  rules: 'Which rules complete each activity?',
  ruleValues: 'What values should those rules use?',
  rewards: 'Which reward is paid, and at which level?',
});

/**
 * Which steps are still unanswered, in order.
 *
 * `caps` is **not** a step: §4's step 8 defaults caps from the reward policy, and a campaign with
 * no explicit cap is a valid campaign (11-BUDGETS-AND-LIMITS.md §8.5 — no ceiling means unlimited,
 * not blocked). Making it required would invent a rule the wizard does not have, and the agent may
 * not be stricter than the path it is a shortcut for.
 */
export function missingSlots(slots: AgentSlots): readonly SlotStep[] {
  const missing: SlotStep[] = [];
  if (slots.archetype === null) missing.push('archetype');
  if (slots.name === null) missing.push('name');
  if (slots.campaignCode === null) missing.push('campaignCode');
  if (slots.startDate === null) missing.push('startDate');
  if (slots.endDate === null) missing.push('endDate');
  if (slots.budgetAmount === null || slots.budgetCurrency === null) missing.push('budget');
  if (slots.merchants.length === 0) missing.push('merchants');
  if (slots.activities.length === 0) missing.push('activities');
  if (slots.trackerName === null || slots.completionLogic === null) missing.push('tracker');
  if (slots.activities.length > 0 && !everyActivityHasARule(slots)) missing.push('rules');
  if (slots.rules.length > 0 && slots.rules.some((rule) => !hasAnyValue(rule))) {
    missing.push('ruleValues');
  }
  if (slots.rewards.length === 0) missing.push('rewards');
  return missing;
}

/**
 * Every chosen activity needs at least one rule, because every component needs at least one rule —
 * `structural-validation.ts`'s `COMPONENT_HAS_NO_RULE` would refuse the submission otherwise, and
 * discovering that at step 7 of a wizard the maker never opened is a bad way to find out.
 */
function everyActivityHasARule(slots: AgentSlots): boolean {
  return slots.activities.every((activityOptionId) =>
    slots.rules.some((rule) => rule.activityOptionId === activityOptionId),
  );
}

/**
 * A rule with a declared parameter schema but no values is incomplete; a rule with **no**
 * parameters is complete with an empty object. This function cannot tell the two apart without the
 * schema, so it treats "no values at all" as answered only when the rule declared none — which the
 * orchestrator records by writing `{}` explicitly. An absent `values` key cannot occur:
 * {@link slotRuleSchema} makes it required.
 */
function hasAnyValue(rule: SlotRule): boolean {
  return rule.values !== null && typeof rule.values === 'object';
}

/** The one thing the agent is asking about right now, as a sentence. */
export function nextStep(slots: AgentSlots): string {
  const missing = missingSlots(slots);
  return missing.length === 0
    ? 'Everything is answered — review the plan and confirm it.'
    : STEP_PROMPT[missing[0]];
}

/** Whether the slot store is complete enough to build a plan from. */
export function isComplete(slots: AgentSlots): boolean {
  return missingSlots(slots).length === 0;
}

/**
 * Whether a turn made progress, for §9's stall rule.
 *
 * Compared structurally rather than by counting filled slots: a turn that *replaced* a merchant
 * selection made progress even though the count did not change, and a turn that re-sent the same
 * patch did not, even though it looked like an update.
 */
export function madeProgress(before: AgentSlots, after: AgentSlots): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}
