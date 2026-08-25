/**
 * T-048 — the deterministic policy engine (10-AI-CAMPAIGN-AGENT.md §6).
 *
 * > *"Economic and temporal safety is decided by code, never by the model … A violation is
 * > returned to the LLM as a **structured error to explain to the user**, not as something for it
 * > to work around. The model's job is to communicate the constraint, not to negotiate with it."*
 *
 * ### What this file is, and — more importantly — what it is not
 *
 * §6 lists six checks. Three of them are **already enforced, authoritatively, elsewhere**, by code
 * the agent is obliged to go through:
 *
 * | §6 check | Authoritative enforcement |
 * |---|---|
 * | every merchant in the maker's tenant | `ScopedRepository` on `Merchant` + `MerchantNotInTenantError` (T-037) |
 * | every activity belonging to its merchant | `journey.service.ts#assertActivityOffered` (T-037 note 8) |
 * | every rule version assigned to the country | `bindings.service.ts#resolveRule` + `RuleMaster`'s scope strategy |
 * | every parameter value valid against the schema | `buildRuleValueSchema`, re-parsed server-side (T-037 note 9) |
 * | caps within the reward policy's limits | `caps.service.ts` + `campaignCapInputSchema` + six live CHECK constraints |
 *
 * Re-implementing any of them here would produce a **second, weaker copy** of a control — the
 * exact failure 10-AI §1 exists to prevent. So this engine checks the two things nothing else
 * checks *at conversation time*, plus the two the design doc names that are genuinely local:
 *
 *  - **temporal ordering and window** — `end_date > start_date`, `start_date` not in the past;
 *  - **budget within the tenant's configured ceiling** (§6, TC-17), read live from
 *    `tenant_budget_ceilings`;
 *  - **archetype shape** — delegated to the registry, which is where a *kind* of campaign's own
 *    rules live;
 *  - **internal consistency of the slot store** — a reward attached to a component the maker did
 *    not choose, a rule bound to an activity that is not in the journey. These are references
 *    *within the conversation*, so nothing downstream could have checked them yet.
 *
 * Everything else is left to the layer that owns it, and the agent finds out the same way a
 * `curl` would: the call fails. That is a feature. A campaign the agent could assemble but the
 * portal would refuse is a campaign that never gets created, which is strictly better than one the
 * agent talked itself into.
 *
 * ### Why this returns violations instead of throwing
 *
 * The caller decides what a violation means. During the conversation it is something for the model
 * to *explain* (§6) and the turn continues; at `POST /plan` and `POST /confirm` it is a 422. One
 * evaluation, two consequences — and the model never sees a code path where its explanation is
 * mistaken for permission.
 */
import { Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { TenantBudgetCeiling } from '@/database/models';
import { isBeforeTodayInItsOwnOffset } from '@reward-portal/shared';
import { isCampaignDate, toCalendarDate as calendarDay } from '@/modules/campaigns/campaign-date';
import { ROW_ACTIVE } from '@/modules/campaigns/campaigns.constants';
import { parse as parseDecimal } from '@/modules/campaigns/decimal.util';
import type { AgentSlots } from './agent.state';
import { ArchetypeRegistry } from './archetypes/archetype.registry';

/** One refusal. `code` reaches the client in `details`; `message` is what the model explains. */
export interface PolicyViolation {
  readonly code: string;
  readonly message: string;
}

export interface PolicyVerdict {
  readonly ok: boolean;
  readonly violations: readonly PolicyViolation[];
}

@Injectable()
export class PolicyEngineService {
  constructor(
    private readonly scoped: ScopedRepository,
    private readonly archetypes: ArchetypeRegistry,
  ) {}

  /**
   * The whole verdict. `tenantId` comes from the actor's verified scope, never from a slot — there
   * is no slot that could carry it (R3, and `agentSlotsSchema` is `.strict()`).
   */
  async evaluate(
    slots: AgentSlots,
    tenantId: number,
    transaction?: Transaction,
  ): Promise<PolicyVerdict> {
    const violations: PolicyViolation[] = [
      ...this.checkDates(slots),
      ...this.checkInternalReferences(slots),
      ...this.checkArchetype(slots),
      ...(await this.checkBudgetCeiling(slots, tenantId, transaction)),
    ];
    return { ok: violations.length === 0, violations };
  }

  // --- temporal (§6, TC-18) --------------------------------------------------------------------

  /**
   * `end_date >= start_date`; `start_date` not in the past.
   *
   * Every rule here is the wizard's rule, reached through the wizard's own objects
   * (`isCampaignDate`, `isBeforeTodayInItsOwnOffset`) rather than reimplemented — an agent
   * that disagreed with the wizard about what "today" is, or about which day a value names, could
   * produce a campaign a human maker could not have produced by hand, which is exactly what
   * 10-AI-CAMPAIGN-AGENT.md §1 forbids.
   *
   * A campaign date is a **calendar date** (T-065): `2026-09-01`. An instant with an offset is
   * still accepted, because the model has been known to volunteer one and reducing it to the day
   * it names in its own offset loses nothing. `>=` rather than `>` for the same reason the shared
   * schema uses it — the end date is the last active day, inclusive, so a single-day campaign has
   * `end == start`.
   */
  private checkDates(slots: AgentSlots): readonly PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    const { startDate, endDate } = slots;

    for (const [label, value] of [
      ['start', startDate],
      ['end', endDate],
    ] as const) {
      if (value !== null && !isCampaignDate(value)) {
        violations.push({
          code: `DATE_${label.toUpperCase()}_MALFORMED`,
          message:
            `The ${label} date must be a calendar date, for example 2026-09-01. ` +
            'A campaign runs for whole days, so it carries no time of day.',
        });
      }
    }
    if (violations.length > 0) return violations;

    if (startDate !== null && endDate !== null && calendarDay(endDate) < calendarDay(startDate)) {
      violations.push({
        code: 'DATE_ORDER',
        message: 'The campaign cannot end before it starts. Which of the two dates should change?',
      });
    }
    if (startDate !== null && isBeforeTodayInItsOwnOffset(startDate)) {
      violations.push({
        code: 'DATE_START_IN_PAST',
        message: 'The campaign cannot start on a day that has already passed.',
      });
    }
    return violations;
  }

  // --- internal consistency of the conversation ------------------------------------------------

  /**
   * References *inside* the slot store — the only kind nothing downstream has seen yet.
   *
   * Each of these would eventually surface as a failed API call or a structural issue at submit;
   * catching them here is the difference between "the agent explained that a reward has to attach
   * to something in the journey" and "five calls succeeded and the sixth 400'd".
   */
  private checkInternalReferences(slots: AgentSlots): readonly PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    const chosenActivities = new Set(slots.activities);

    for (const rule of slots.rules) {
      if (!chosenActivities.has(rule.activityOptionId)) {
        violations.push({
          code: 'RULE_TARGETS_UNCHOSEN_ACTIVITY',
          message:
            'One of the rules is attached to an activity that is not part of this campaign. ' +
            'Either add that activity, or move the rule onto one that is.',
        });
        break;
      }
    }

    for (const reward of slots.rewards) {
      if (reward.level === 'component' && reward.activityOptionId === null) {
        violations.push({
          code: 'REWARD_COMPONENT_WITHOUT_ACTIVITY',
          message: 'A reward attached at activity level has to say which activity it pays for.',
        });
        break;
      }
      if (
        reward.level === 'component' &&
        reward.activityOptionId !== null &&
        !chosenActivities.has(reward.activityOptionId)
      ) {
        violations.push({
          code: 'REWARD_TARGETS_UNCHOSEN_ACTIVITY',
          message:
            'A reward is attached to an activity that is not part of this campaign. ' +
            'Choose one of the activities already in the journey.',
        });
        break;
      }
      if (reward.level !== 'component' && reward.activityOptionId !== null) {
        violations.push({
          code: 'REWARD_LEVEL_MISMATCH',
          message:
            'A reward at campaign or tracker level pays for the whole thing, so it must not name ' +
            'a single activity.',
        });
        break;
      }
    }

    // Mirrors `attachRewardRequestSchema`'s uniqueness constraints (`uq_rca_*`): the same policy
    // twice at the same attachment point is a duplicate row the database would refuse.
    const seen = new Set<string>();
    for (const reward of slots.rewards) {
      const key = `${reward.level}:${reward.activityOptionId ?? ''}:${reward.rewardOptionId}`;
      if (seen.has(key)) {
        violations.push({
          code: 'REWARD_ATTACHED_TWICE',
          message: 'The same reward is attached twice at the same place. One of them can go.',
        });
        break;
      }
      seen.add(key);
    }

    return violations;
  }

  // --- archetype shape --------------------------------------------------------------------------

  private checkArchetype(slots: AgentSlots): readonly PolicyViolation[] {
    if (slots.archetype === null) return [];
    return this.archetypes.get(slots.archetype).validateShape(slots);
  }

  // --- economic (§6, TC-17) ---------------------------------------------------------------------

  /**
   * *"Budget within the tenant's configured ceiling."*
   *
   * Read live from `tenant_budget_ceilings` through `ScopedRepository`, matched on the campaign's
   * own currency. **No ceiling row for that unit means unlimited, not blocked** —
   * 11-BUDGETS-AND-LIMITS.md §8.5, and the same interpretation `caps.service.ts#tenantCeilings`
   * already applies. Inventing a default ceiling here would make the agent stricter than the
   * wizard, which is a way of being wrong.
   *
   * Amounts are compared as decimal **strings**, through T-037's own comparator: money crosses
   * every boundary in this system as a string, and parsing `budgetAmount` into a float to compare
   * it against a ceiling would reintroduce exactly the representation the rest of the module went
   * to some trouble to avoid.
   */
  private async checkBudgetCeiling(
    slots: AgentSlots,
    tenantId: number,
    transaction?: Transaction,
  ): Promise<readonly PolicyViolation[]> {
    const { budgetAmount, budgetCurrency } = slots;
    if (budgetAmount === null || budgetCurrency === null) return [];

    const ceilings = await this.scoped.listAll(TenantBudgetCeiling, {
      where: { tenantId, status: ROW_ACTIVE },
      transaction,
    });

    const ceiling = ceilings.find(
      (row) => row.unitType === 'currency' && row.unitCode.trim() === budgetCurrency,
    );
    if (ceiling === undefined) return [];

    // `parse` returns `null` for anything it cannot read exactly, and the callers in T-037 treat
    // that as "cannot be compared, so do not warn". The same fail-safe direction applies here: a
    // missing refusal is recoverable (the wizard's own submit-time gate still refuses), a false
    // one would block a legitimate campaign on a formatting quirk.
    const budget = parseDecimal(budgetAmount);
    const maximum = parseDecimal(ceiling.maxCampaignBudget);
    if (budget === null || maximum === null) return [];

    if (budget > maximum) {
      return [
        {
          code: 'BUDGET_ABOVE_TENANT_CEILING',
          message:
            `This tenant's ceiling for one ${budgetCurrency} campaign is ` +
            `${ceiling.maxCampaignBudget}, and ${budgetAmount} is above it. ` +
            'Lower the budget, or ask a tenant administrator to raise the ceiling.',
        },
      ];
    }
    return [];
  }
}
