/**
 * T-048 — the constants of the campaign agent, in one place because most of them are limits and a
 * limit buried in the code it constrains is a limit nobody reviews.
 */

/**
 * The permission the whole agent surface requires.
 *
 * Deliberately **`campaign` / `create`**, not a new `agent` entity: the agent creates campaigns as
 * the maker, so anyone who may use it is by definition someone who may create a campaign, and
 * anyone who may not is by definition someone who may not. A separate entity would be a second
 * switch that could be left on after the first was turned off — and seeding one would need a
 * migration outside this task's file scope anyway (R9).
 */
export const CAMPAIGN_ENTITY = 'campaign';

/** `agent_sessions.state`, mirroring `ck_as_state` (T048_001). */
export const AGENT_STATE = Object.freeze({
  COLLECTING: 'collecting',
  REVIEWING: 'reviewing',
  CREATED: 'created',
  ABANDONED: 'abandoned',
  ERROR: 'error',
} as const);

/** `agent_session_events.role`, mirroring `ck_ase_role`. */
export const EVENT_ROLE = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
  SYSTEM: 'system',
} as const);

/**
 * §9 — *"after 3 turns with no slot progress, offer the wizard"*.
 *
 * Counted server-side and persisted on the session, so reloading the page does not reset it. The
 * wizard is offered, never forced: the maker may keep talking, and the agent keeps trying.
 */
export const STALL_TURNS_BEFORE_WIZARD = 3;

/** How many times a malformed model response is re-asked before the agent gives up on the model
 * for this turn and asks the maker a direct question instead (§9, TC-13). One, not three: a model
 * that cannot produce valid JSON twice in a row will not produce it on the fourth attempt, and
 * every retry is a wall-clock second the maker waits. */
export const JSON_REPAIR_ATTEMPTS = 1;

/** Upper bound on one conversation. Not a business rule — a runaway guard, so a model that loops
 * costs a bounded number of rows rather than an unbounded number. */
export const MAX_TURNS_PER_SESSION = 200;

/** How many options one tool call may return. Small on purpose: the model picks from a list it
 * can hold, and a 500-row merchant dump is both useless to it and a large prompt. */
export const MAX_OPTIONS_PER_TOOL = 25;

/** Hard cap on a maker's message, matching `sendAgentMessageRequestSchema`. */
export const MAX_MESSAGE_LENGTH = 4000;

/** The wizard route the agent hands off to, and falls back to whenever it cannot help (§9). It is
 * a *path*, resolved by the SPA's router — never a URL this server builds. */
export const WIZARD_PATH = '/campaigns';

/** The `campaign_audit_trail` provenance marker (§7, TC-3). */
export const CREATED_VIA_AI_AGENT = 'ai_agent';

/** Prefixes for the opaque option tokens. See `option-resolver.service.ts` — the model may
 * reference one, and can never construct one that resolves. */
export const OPTION_PREFIX = Object.freeze({
  MERCHANT: 'm',
  ACTIVITY: 'a',
  RULE: 'r',
  REWARD: 'rw',
} as const);
