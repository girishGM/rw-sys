/**
 * T-048 — the tool whitelist (10-AI-CAMPAIGN-AGENT.md §5).
 *
 * > *"There is no `executeSql`, no `writeAnyTable`, no `createRule`, no `submitForApproval`. A
 * > capability that does not exist cannot be talked into existing."*
 *
 * This file is the whole of that sentence made mechanical. {@link TOOL_NAMES} is a `const`
 * tuple; {@link ToolName} is its union; the orchestrator's dispatch is a `switch` over that union,
 * so a name the model invents does not reach a `default` branch that might do something — it fails
 * {@link isToolName} first, and TypeScript's exhaustiveness check means adding a name to the tuple
 * without implementing it is a **compile error**. There is no registration function, no map keyed
 * by string, and no place a tool could be added at runtime (TC-11).
 *
 * ### Why the two write-adjacent entries are still not writes
 *
 * §5's table marks `buildPlan` and `createCampaignDraft` as the only non-read-only tools. Even
 * those are not writes *by the model*:
 *
 *  - `buildPlan` produces a plan and a hash. Nothing is persisted that a maker has not seen.
 *  - `createCampaignDraft` is **not callable from a model turn at all** in this implementation.
 *    It is reachable only from `POST /campaign-agent/sessions/:id/confirm`, i.e. from a human
 *    click carrying a matching plan hash (§3.2). It appears in this registry because §5 lists it
 *    and because the orchestrator must be able to *tell the model it exists* — so the model can
 *    say "shall I create it?" — but {@link MODEL_INVOCABLE_TOOLS} is what the dispatcher consults,
 *    and it does not contain it.
 *
 * That is a deliberate narrowing of §5, in the safe direction: the design doc allows the model to
 * call `createCampaignDraft` with a matching hash, and this implementation requires the click
 * instead. §3.2's own flow diagram is the stricter reading — *"maker clicks 'Create this
 * campaign' (the hash is submitted with the click)"* — and the two are reconciled here by making
 * the click the only caller. Recorded in the completion report.
 */

/** Every tool that exists. §5's table, in §5's order. */
export const TOOL_NAMES = [
  'searchMerchants',
  'listMerchantActivities',
  'listAvailableRules',
  'getRuleParameters',
  'listAvailableRewards',
  'getRewardPolicies',
  'validateSlots',
  'buildPlan',
  'createCampaignDraft',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The tools a **model turn** may invoke.
 *
 * `createCampaignDraft` is absent — see this file's header. `buildPlan` is present because asking
 * for the review panel is a reasonable thing for the model to do once the slots are full, and
 * building a plan changes nothing a maker has not already answered.
 */
export const MODEL_INVOCABLE_TOOLS: readonly ToolName[] = [
  'searchMerchants',
  'listMerchantActivities',
  'listAvailableRules',
  'getRuleParameters',
  'listAvailableRewards',
  'getRewardPolicies',
  'validateSlots',
  'buildPlan',
];

/** Whether `value` names a tool at all. The first gate on anything the model emits. */
export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value);
}

/** Whether a model turn may invoke `name`. The second gate. */
export function isModelInvocable(name: ToolName): boolean {
  return MODEL_INVOCABLE_TOOLS.includes(name);
}

/**
 * What each tool is for, in the words the system prompt uses.
 *
 * Descriptions live here rather than in the prompt file so that adding a tool and describing it
 * are one edit. Every description is written to be *useless as an instruction*: it says what the
 * tool returns, never what the model should conclude, because a description is untrusted text the
 * model will read alongside untrusted merchant names.
 */
export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = Object.freeze({
  searchMerchants:
    'Returns merchant options matching a text query. Input: { "query": string }. ' +
    'Only merchants in the maker’s own tenant are ever returned.',
  listMerchantActivities:
    'Returns the activity options offered by the merchants already chosen. Input: {}.',
  listAvailableRules:
    'Returns the rule options available to the maker’s country, each with a version. Input: {}.',
  getRuleParameters:
    'Returns the parameter schema of one rule, which decides what values to ask for. ' +
    'Input: { "ruleOptionId": string }.',
  listAvailableRewards: 'Returns the reward options available to the maker’s country. Input: {}.',
  getRewardPolicies:
    'Returns the caps and rates configured on one reward. Input: { "rewardOptionId": string }.',
  validateSlots:
    'Runs the deterministic policy engine over the answers collected so far and returns any ' +
    'violations to explain to the maker. Input: {}.',
  buildPlan:
    'Assembles the complete plan and its hash for the maker to review. Input: {}. ' +
    'Only succeeds once every question has been answered.',
  createCampaignDraft:
    'Creates the draft campaign. NOT callable from a reply — it runs only when the maker clicks ' +
    'the confirm button, which submits the plan hash.',
});
