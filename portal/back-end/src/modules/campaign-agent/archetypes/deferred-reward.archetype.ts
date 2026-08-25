/**
 * T-048 — *"a tracker counts qualifying events against a completion rule; when satisfied, a reward
 * fires"*.
 *
 * Ported from `agents/create-campaign-v2/src/archetypes/deferred-reward.archetype.ts`, which had
 * no structural rules of its own beyond the base schema. This port has one, and it exists because
 * the portal's tracker model makes a mistake possible that the standalone agent's did not:
 * `completionLogic: 'n_of'` with a threshold above the component count produces a tracker no
 * customer can ever complete. `journey.service.ts` refuses that at the write (T-037 note 4,
 * `UnachievableThresholdError`) — this check exists so the maker is told during the conversation
 * rather than at execution, which is the difference between an explanation and a stack of failed
 * API calls.
 *
 * It is a **duplicate** of a server-side control, not a replacement for one, and that is the
 * correct relationship: §6 requires the policy engine to be deterministic code the model cannot
 * negotiate with, and T-037's own check remains authoritative for every caller including this one.
 */
import type { CampaignArchetype, ArchetypeViolation } from './archetype.interface';
import type { AgentSlots } from '../agent.state';

export class DeferredRewardArchetype implements CampaignArchetype {
  readonly key = 'deferred_reward' as const;
  readonly label = 'Deferred reward';
  readonly description =
    'A tracker counts qualifying activities; when the completion rule is satisfied, the reward fires.';

  readonly intentKeywords = [
    'after',
    'complete',
    'collect',
    'stamp',
    'milestone',
    'journey',
    'streak',
    'over the',
    'wait',
  ] as const;

  /** A multi-step journey most often means "do all of these", which is also the shape a maker
   * gets least wrong. `n_of` is available and is asked about explicitly when they want it. */
  readonly defaultCompletionLogic = 'all' as const;

  validateShape(slots: AgentSlots): readonly ArchetypeViolation[] {
    const violations: ArchetypeViolation[] = [];

    if (slots.completionLogic === 'n_of') {
      const threshold = slots.completionThreshold;
      if (threshold === null) {
        violations.push({
          code: 'DEFERRED_REWARD_THRESHOLD_REQUIRED',
          message:
            'A "complete N of M" tracker needs to know what N is. How many of the chosen ' +
            'activities must a customer complete?',
        });
      } else if (threshold > slots.activities.length) {
        violations.push({
          code: 'DEFERRED_REWARD_THRESHOLD_UNACHIEVABLE',
          message:
            `The tracker asks for ${threshold} completed activities but only ` +
            `${slots.activities.length} were chosen, so no customer could ever finish it. ` +
            `Either lower the threshold to ${slots.activities.length} or fewer, or add activities.`,
        });
      }
    }

    return violations;
  }
}
