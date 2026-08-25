/**
 * T-048 — an archetype: the shape a *kind* of campaign has, beyond what any campaign has.
 *
 * Ported from `agents/create-campaign-v2/src/archetypes/archetype.interface.ts`, with its one
 * structural idea intact — *"an archetype declares its identity and any structural rules beyond
 * the base schema"* — and its SQL-era assumptions dropped. In the standalone agent an archetype
 * could reach for `processingType: 'cron'` and `waitingPeriodDays` because it was writing
 * `tracker_components` itself. Here it cannot: the portal's component DTO
 * (`CreateComponentDto`) has neither field, because 12-CAMPAIGN-STRUCTURE.md §2 gives a component
 * exactly one targeting dimension. So an archetype in the portal is what remains once the
 * capability to invent structure is removed: a **detector**, a set of **defaults**, and a set of
 * **shape rules**.
 *
 * That is a smaller thing than the standalone agent's archetype, and deliberately so. Anything an
 * archetype could enforce that the wizard could not would be a campaign a human maker could not
 * have built by hand — precisely what 10-AI-CAMPAIGN-AGENT.md §1 forbids.
 */
import type { AgentArchetype, TrackerCompletionLogic } from '@reward-portal/shared';
import type { AgentSlots } from '../agent.state';

/** One structural objection. `code` is what travels to the client; `message` is for the model to
 * explain and for the server log. */
export interface ArchetypeViolation {
  readonly code: string;
  readonly message: string;
}

export interface CampaignArchetype {
  readonly key: AgentArchetype;
  readonly label: string;
  /** One sentence, shown to the maker when the agent proposes this archetype. */
  readonly description: string;

  /**
   * Words in the maker's opening message that indicate this archetype (§4 step 1).
   *
   * Matched by Zone 2, **not** by the model — an archetype chosen by the model would be a
   * structural decision made by an untrusted component, and the detector is three lines of code
   * that can be read and tested. The model's own suggestion is still accepted through the slot
   * patch; this is what fires when the maker's first sentence already answers the question.
   */
  readonly intentKeywords: readonly string[];

  /** The tracker completion logic this archetype defaults to when the maker expresses none. */
  readonly defaultCompletionLogic: TrackerCompletionLogic;

  /** Structural rules beyond the generic ones in `policy-engine.service.ts`. */
  validateShape(slots: AgentSlots): readonly ArchetypeViolation[];
}
