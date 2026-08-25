/**
 * T-048 — *"a single qualifying event fires the reward immediately"*.
 *
 * Ported from `agents/create-campaign-v2/src/archetypes/instant-reward.archetype.ts`. Two of the
 * original's three checks are gone, and their absence is the point rather than an omission:
 * `instant_reward_realtime_only` and `instant_reward_no_waiting_period` both constrained
 * `tracker_components.processing_type` / `waiting_period_days`, which the portal's component DTO
 * does not expose at all (12-CAMPAIGN-STRUCTURE.md §2 — the activity is a component's only
 * targeting dimension, and BACKLOG B-14 keeps it that way). A check on a field nobody can set is
 * theatre; the *capability* is what is absent here, which is stronger.
 *
 * What survives is the one rule that is still expressible and still meaningful: an instant-reward
 * campaign is a **single-step** campaign. Two components would mean the customer has to do two
 * things before anything pays out, which is a deferred reward wearing the wrong label — and a
 * maker who wanted that would end up debugging why "instant" was not.
 */
import type { CampaignArchetype, ArchetypeViolation } from './archetype.interface';
import type { AgentSlots } from '../agent.state';

export class InstantRewardArchetype implements CampaignArchetype {
  readonly key = 'instant_reward' as const;
  readonly label = 'Instant reward';
  readonly description =
    'A single qualifying event fires the reward immediately — one activity, no multi-step journey.';

  /** Deliberately narrow. "Weekend cashback on every payment" is the canonical phrasing §4 uses. */
  readonly intentKeywords = [
    'instant',
    'immediately',
    'straight away',
    'cashback',
    'every purchase',
    'every payment',
    'every transaction',
  ] as const;

  /** One step, so "all of one thing" — `n_of` over a single component would be a confusing
   * spelling of the same thing. */
  readonly defaultCompletionLogic = 'all' as const;

  validateShape(slots: AgentSlots): readonly ArchetypeViolation[] {
    const violations: ArchetypeViolation[] = [];

    if (slots.activities.length > 1) {
      violations.push({
        code: 'INSTANT_REWARD_SINGLE_ACTIVITY',
        message:
          `An instant-reward campaign tracks exactly one activity, but ${slots.activities.length} ` +
          'were chosen. Either drop the extras, or switch to a deferred-reward campaign, which is ' +
          'the shape for a multi-step journey.',
      });
    }

    // `n_of` needs at least two components to mean anything, and an instant reward has one.
    if (slots.completionLogic === 'n_of') {
      violations.push({
        code: 'INSTANT_REWARD_NO_THRESHOLD',
        message:
          'An instant-reward campaign completes on its single activity, so a "complete N of M" ' +
          'threshold has nothing to count. Use "all".',
      });
    }

    return violations;
  }
}
