/**
 * T-048 — `validateSlots` and `buildPlan`, the two Zone 2 tools (10-AI-CAMPAIGN-AGENT.md §5).
 *
 * ### `buildPlan` is where every `optionId` becomes a real id, and the only place it happens
 *
 * The slot store holds nothing but opaque tokens (`agent.state.ts`). This file turns them into
 * `merchantId`, `activityId`, `ruleId` and `rewardPolicyId` — and it does so by asking
 * `option-resolver.service.ts`, which runs both gates: *was this ever offered* and *does it still
 * resolve in this maker's scope*. So the plan is, by construction, a plan this maker could have
 * built by hand (§1), and an injected or hallucinated token cannot survive the trip (TC-7, TC-8,
 * TC-9, TC-10).
 *
 * It is deliberately the **single** conversion point. If a second one existed — say, a fast path
 * that trusted the slots because they had been validated once already — that path would be the one
 * an attacker aimed at. There is no such path: `portal-api.client.ts` accepts a plan and nothing
 * else, and the only producer of a plan is this file.
 *
 * ### The plan is rebuilt, never reloaded
 *
 * `POST /plan` builds it and hashes it; `POST /confirm` builds it **again** from the same slots and
 * compares hashes (§3.2). `agent_sessions.plan` therefore holds a copy for display only, and no
 * code path executes it. That is what makes TC-15 fail closed whichever half was tampered with —
 * see `plan-hash.service.ts`'s header.
 */
import { Injectable } from '@nestjs/common';
import type { AgentPlan, AgentPlanComponent, AgentPlanReward } from '@reward-portal/shared';
import { toCalendarDate as campaignDay } from '@/modules/campaigns/campaign-date';
import { PolicyEngineService, type PolicyVerdict } from '../policy-engine.service';
import { PlanHashService } from '../plan-hash.service';
import {
  OptionResolverService,
  parseOptionId,
  type OfferedOptions,
  type OptionKind,
} from '../option-resolver.service';
import { ArchetypeRegistry } from '../archetypes/archetype.registry';
import { isComplete, missingSlots, type AgentSlots } from '../agent.state';
import {
  PlanIncompleteError,
  PolicyViolationError,
  UnresolvableOptionError,
} from '../agent.errors';

export interface BuiltPlan {
  readonly plan: AgentPlan;
  readonly planHash: string;
}

@Injectable()
export class PlanTool {
  constructor(
    private readonly policy: PolicyEngineService,
    private readonly hasher: PlanHashService,
    private readonly options: OptionResolverService,
    private readonly archetypes: ArchetypeRegistry,
  ) {}

  /**
   * §5 `validateSlots` — *"policy-engine verdict; deterministic, not the LLM"*.
   *
   * Returns rather than throws: during a conversation a violation is something for the model to
   * *explain* (§6), and the turn continues. `POST /plan` and `POST /confirm` call
   * {@link buildOrThrow} instead, which turns the same verdict into a 422.
   */
  async validateSlots(slots: AgentSlots, tenantId: number): Promise<PolicyVerdict> {
    return this.policy.evaluate(slots, tenantId);
  }

  /**
   * §5 `buildPlan` — *"canonical plan + hash; Zone 2 only"*.
   *
   * Refuses on an incomplete slot store (422 naming the missing steps) and on a policy violation
   * (422 naming the codes). Both refusals are *before* any resolution, so a maker who has not
   * finished answering never triggers a database round trip per option.
   */
  async buildOrThrow(
    slots: AgentSlots,
    offered: OfferedOptions,
    tenantId: number,
  ): Promise<BuiltPlan> {
    if (!isComplete(slots)) throw new PlanIncompleteError(missingSlots(slots));

    const verdict = await this.policy.evaluate(slots, tenantId);
    if (!verdict.ok) {
      throw new PolicyViolationError(verdict.violations.map((violation) => violation.code));
    }

    const plan = await this.assemble(slots, offered);
    return { plan, planHash: this.hasher.hash(plan) };
  }

  // --- private -----------------------------------------------------------------------------------

  /**
   * Every token → its row, through both gates, then into the plan's shape.
   *
   * The resolution order matches §4's conversation order, which is not decorative: activities are
   * resolved after merchants because a component targeting an activity no chosen merchant offers is
   * refused at the write anyway (T-037 note 8), and rules after activities because a rule binds to
   * a component.
   */
  private async assemble(slots: AgentSlots, offered: OfferedOptions): Promise<AgentPlan> {
    const archetype = slots.archetype;
    // `isComplete` has already established this; the check is here so the type narrows without a
    // non-null assertion (R8).
    if (archetype === null) throw new PlanIncompleteError(['archetype']);

    // Four bulk resolutions, one per option kind — not one per token. Both gates run over the
    // whole set at once, and the results are keyed by the token that produced them, so nothing
    // downstream depends on the resolver returning rows in the order they were asked for (it does
    // not: every resolver sorts by name, which is the right order for an option list and the wrong
    // one for an index-aligned zip).
    const merchants = await this.resolveByToken(
      slots.merchants,
      (ids) => this.options.resolveMerchants(offered, ids),
      'merchants',
    );
    const activities = await this.resolveByToken(
      slots.activities,
      (ids) => this.options.resolveActivities(offered, ids),
      'activities',
    );
    const rules = await this.resolveByToken(
      slots.rules.map((rule) => rule.ruleOptionId),
      (ids) => this.options.resolveRules(offered, ids),
      'rules',
    );
    const policies = await this.resolveByToken(
      slots.rewards.map((reward) => reward.rewardOptionId),
      (ids) => this.options.resolveRewardPolicies(offered, ids),
      'rewards',
    );

    // One component per chosen activity, in the order the maker chose them. That is the shape §4
    // describes (steps 3–6 walk merchants → activities → rules) and the shape the wizard produces
    // when a maker adds one component per activity; the agent does not invent a structure the
    // wizard could not express.
    const componentIndexByActivityOption = new Map<string, number>();
    const components: AgentPlanComponent[] = slots.activities.map((activityOptionId, index) => {
      const activity = activities.get(activityOptionId);
      if (activity === undefined) throw new PlanIncompleteError(['activities']);
      componentIndexByActivityOption.set(activityOptionId, index);

      return {
        name: activity.name,
        activityId: activity.id,
        activityName: activity.name,
        rules: slots.rules
          .filter((slotRule) => slotRule.activityOptionId === activityOptionId)
          .map((slotRule) => {
            const rule = rules.get(slotRule.ruleOptionId);
            if (rule === undefined) throw new PlanIncompleteError(['rules']);
            return {
              ruleId: rule.id,
              ruleCode: rule.ruleCode,
              ruleName: rule.name,
              // The **version pin is not the agent's to choose** (06-VERSIONING.md §7):
              // `bindings.service.ts#resolveRule` pins the version assigned to the maker's country
              // at the moment of the bind, exactly as it does for the wizard. Carrying `null` here
              // is honest rather than lossy — the plan records which rule, and the portal records
              // which version of it, from the same country assignment.
              ruleVersionId: null,
              ruleVersionNo: null,
              values: slotRule.values,
            };
          }),
      };
    });

    const rewards: AgentPlanReward[] = slots.rewards.map((reward) => {
      const policy = policies.get(reward.rewardOptionId);
      if (policy === undefined) throw new PlanIncompleteError(['rewards']);
      return {
        level: reward.level,
        componentIndex:
          reward.level === 'component' && reward.activityOptionId !== null
            ? (componentIndexByActivityOption.get(reward.activityOptionId) ?? null)
            : null,
        rewardPolicyId: policy.id,
        policyName: policy.name,
      };
    });

    return {
      archetype,
      campaign: {
        campaignCode: requireString(slots.campaignCode, 'campaignCode'),
        name: requireString(slots.name, 'name'),
        description: slots.description,
        // Reduced to the calendar day the slot names (T-065). The plan is both what the maker
        // reads and what is hashed, so it must carry the day they will see in the wizard — not
        // whichever instant form the model happened to phrase it in this turn. `campaignDay`
        // throws only on a value the policy engine has already refused.
        startDate: campaignDay(requireString(slots.startDate, 'startDate')),
        endDate: campaignDay(requireString(slots.endDate, 'endDate')),
        budgetAmount: slots.budgetAmount,
        budgetCurrency: slots.budgetCurrency,
      },
      merchants: slots.merchants.map((optionId) => {
        const merchant = merchants.get(optionId);
        if (merchant === undefined) throw new PlanIncompleteError(['merchants']);
        return { merchantId: merchant.id, name: merchant.name };
      }),
      tracker: {
        name: requireString(slots.trackerName, 'tracker'),
        completionLogic:
          slots.completionLogic ?? this.archetypes.get(archetype).defaultCompletionLogic,
        completionThreshold: slots.completionThreshold,
      },
      components,
      rewards,
      caps: slots.caps,
    };
  }

  /**
   * Resolves a list of tokens and returns the results **keyed by the token**.
   *
   * The resolvers de-duplicate and re-sort (by name, which is right for an option list and wrong
   * for an index-aligned zip), so pairing by position would silently attach the wrong row to the
   * wrong slot the moment a maker picked two merchants whose alphabetical order differed from
   * their selection order. Keying by token removes that class of bug: a token that resolves to
   * nothing is a hard failure here, never a quiet mismatch three lines later.
   */
  private async resolveByToken<T extends Resolved>(
    optionIds: readonly string[],
    resolve: (ids: readonly string[]) => Promise<readonly T[]>,
    kind: OptionKind,
  ): Promise<ReadonlyMap<string, T>> {
    const byToken = new Map<string, T>();
    if (optionIds.length === 0) return byToken;

    const rows = await resolve(optionIds);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const optionId of optionIds) {
      const id = parseOptionId(kind, optionId);
      if (id === null) throw new UnresolvableOptionError(kind);
      const row = byId.get(id);
      if (row === undefined) throw new UnresolvableOptionError(kind);
      byToken.set(optionId, row);
    }
    return byToken;
  }
}

/** The minimum a resolver's row must expose for {@link PlanTool.resolveByToken} to key it. */
type Resolved = { readonly id: number };

/**
 * A slot `isComplete` has already guaranteed, narrowed without a non-null assertion (R8).
 *
 * Throwing `PlanIncompleteError` rather than a bare `Error` means that if the two ever disagree —
 * a slot `missingSlots` forgot to check — the maker sees "this answer is still missing" rather than
 * a 500, which is both truthful and recoverable.
 */
function requireString(value: string | null, step: string): string {
  if (value === null) throw new PlanIncompleteError([step]);
  return value;
}
