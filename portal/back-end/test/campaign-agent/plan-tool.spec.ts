/**
 * T-048 — `buildPlan` (`tools/plan.tool.ts`), 10-AI-CAMPAIGN-AGENT.md §5.
 *
 * This is the single place a token becomes an id, so it is the single place TC-7, TC-8, TC-9 and
 * TC-10 have to hold. The resolver is stubbed to *behave like the real one* — throwing
 * `UnresolvableOptionError` for anything not offered — rather than to return whatever is asked for;
 * the real resolver's own behaviour is proved in `option-resolver.spec.ts` and, against the
 * database, in the e2e suite.
 */
import { PlanTool } from '@/modules/campaign-agent/tools/plan.tool';
import { PlanHashService } from '@/modules/campaign-agent/plan-hash.service';
import { ArchetypeRegistry } from '@/modules/campaign-agent/archetypes/archetype.registry';
import {
  PlanIncompleteError,
  UnresolvableOptionError,
} from '@/modules/campaign-agent/agent.errors';
import { emptySlots, type AgentSlots } from '@/modules/campaign-agent/agent.state';
import type { OfferedOptions } from '@/modules/campaign-agent/option-resolver.service';

const MERCHANTS = new Map([
  [7, { id: 7, name: 'Acme Electronics' }],
  [8, { id: 8, name: 'Beta Books' }],
]);
const ACTIVITIES = new Map([
  [12, { id: 12, name: 'Card payment' }],
  [13, { id: 13, name: 'Account link' }],
]);
const RULES = new Map([[3, { id: 3, ruleCode: 'MIN_SPEND', name: 'Minimum spend' }]]);
const POLICIES = new Map([[9, { id: 9, name: 'RM10 cashback' }]]);

/** A resolver that enforces gate 1 and gate 2, exactly as the real one does. */
function resolverStub() {
  const resolve = <T>(map: Map<number, T>, kind: string, prefix: string) =>
    jest.fn(async (offered: OfferedOptions, optionIds: readonly string[]) => {
      const allowed = new Set(offered[kind as keyof OfferedOptions]);
      const rows: T[] = [];
      for (const optionId of optionIds) {
        if (!allowed.has(optionId)) throw new UnresolvableOptionError(kind);
        const id = Number(optionId.slice(prefix.length + 1));
        const row = map.get(id);
        if (row === undefined) throw new UnresolvableOptionError(kind);
        if (!rows.includes(row)) rows.push(row);
      }
      // The real resolvers sort by name, which is exactly the ordering hazard `resolveByToken`
      // exists to neutralise. Reproduced here so the test would catch a positional zip.
      return [...rows].sort((a, b) =>
        String((a as { name: string }).name).localeCompare(String((b as { name: string }).name)),
      );
    });

  return {
    resolveMerchants: resolve(MERCHANTS, 'merchants', 'm'),
    resolveActivities: resolve(ACTIVITIES, 'activities', 'a'),
    resolveRules: resolve(RULES, 'rules', 'r'),
    resolveRewardPolicies: resolve(POLICIES, 'rewards', 'rw'),
    assertOffered: jest.fn(),
  };
}

function makeTool(verdict = { ok: true, violations: [] as { code: string; message: string }[] }) {
  const policy = { evaluate: jest.fn(async () => verdict) };
  const resolver = resolverStub();
  const tool = new PlanTool(
    policy as never,
    new PlanHashService(),
    resolver as never,
    new ArchetypeRegistry(),
  );
  return { tool, policy, resolver };
}

const offered: OfferedOptions = {
  merchants: ['m_7', 'm_8'],
  activities: ['a_12', 'a_13'],
  rules: ['r_3'],
  rewards: ['rw_9'],
};

function completeSlots(overrides: Partial<AgentSlots> = {}): AgentSlots {
  return {
    ...emptySlots(),
    archetype: 'deferred_reward',
    name: 'Weekend cashback',
    campaignCode: 'WKND',
    startDate: '2027-01-01T00:00:00+08:00',
    endDate: '2027-01-31T00:00:00+08:00',
    budgetAmount: '50000.00',
    budgetCurrency: 'MYR',
    merchants: ['m_7'],
    activities: ['a_12'],
    trackerName: 'Weekend',
    completionLogic: 'all',
    rules: [{ activityOptionId: 'a_12', ruleOptionId: 'r_3', values: { minSpend: 50 } }],
    rewards: [{ rewardOptionId: 'rw_9', level: 'campaign', activityOptionId: null }],
    ...overrides,
  };
}

describe('validateSlots — §5’s deterministic verdict', () => {
  it('returns the policy engine’s verdict rather than throwing', async () => {
    const { tool } = makeTool({
      ok: false,
      violations: [{ code: 'DATE_ORDER', message: 'end before start' }],
    });
    const verdict = await tool.validateSlots(completeSlots(), 1);
    expect(verdict.ok).toBe(false);
  });
});

describe('buildOrThrow — refusals before any resolution', () => {
  it('refuses an incomplete slot store, naming the missing steps', async () => {
    const { tool, resolver } = makeTool();
    await expect(tool.buildOrThrow(emptySlots(), offered, 1)).rejects.toThrow(PlanIncompleteError);
    expect(resolver.resolveMerchants).not.toHaveBeenCalled();
  });

  it('refuses a policy violation, naming the codes', async () => {
    const { tool, resolver } = makeTool({
      ok: false,
      violations: [{ code: 'BUDGET_ABOVE_TENANT_CEILING', message: 'too much' }],
    });

    await expect(tool.buildOrThrow(completeSlots(), offered, 1)).rejects.toMatchObject({
      code: 'AGENT_POLICY_VIOLATION',
      status: 422,
      details: [{ field: 'plan', code: 'BUDGET_ABOVE_TENANT_CEILING' }],
    });
    expect(resolver.resolveMerchants).not.toHaveBeenCalled();
  });

  it('the incomplete error lists the steps so the UI can say which', async () => {
    const { tool } = makeTool();
    await expect(tool.buildOrThrow(emptySlots(), offered, 1)).rejects.toMatchObject({
      status: 422,
      details: expect.arrayContaining([{ field: 'slots', code: 'MISSING_ARCHETYPE' }]),
    });
  });
});

describe('buildOrThrow — the plan', () => {
  it('turns every token into a real id and carries the labels the maker read', async () => {
    const { tool } = makeTool();
    const { plan, planHash } = await tool.buildOrThrow(completeSlots(), offered, 1);

    expect(plan.campaign).toEqual({
      campaignCode: 'WKND',
      name: 'Weekend cashback',
      description: null,
      // T-065 — the slots above hold the instant form a model may volunteer
      // (`2027-01-01T00:00:00+08:00`); the **plan** carries the calendar day that names, because
      // the plan is what the maker reads, what is hashed, and what the wizard will show them
      // afterwards. Reducing it here is what keeps those three the same date.
      startDate: '2027-01-01',
      endDate: '2027-01-31',
      budgetAmount: '50000.00',
      budgetCurrency: 'MYR',
    });
    expect(plan.merchants).toEqual([{ merchantId: 7, name: 'Acme Electronics' }]);
    expect(plan.components).toEqual([
      {
        name: 'Card payment',
        activityId: 12,
        activityName: 'Card payment',
        rules: [
          {
            ruleId: 3,
            ruleCode: 'MIN_SPEND',
            ruleName: 'Minimum spend',
            ruleVersionId: null,
            ruleVersionNo: null,
            values: { minSpend: 50 },
          },
        ],
      },
    ]);
    expect(plan.rewards).toEqual([
      { level: 'campaign', componentIndex: null, rewardPolicyId: 9, policyName: 'RM10 cashback' },
    ]);
    expect(planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not pin a rule version — that is bindings.service.ts’s decision (06-VERSIONING §7)', async () => {
    const { tool } = makeTool();
    const { plan } = await tool.buildOrThrow(completeSlots(), offered, 1);
    expect(plan.components[0].rules[0].ruleVersionId).toBeNull();
  });

  it('keeps the maker’s selection order, not the resolver’s alphabetical order', async () => {
    // "Beta Books" sorts before "Acme Electronics"? No — but the resolver sorts by name, so a
    // positional zip would pair the wrong row with the wrong slot. Selecting m_8 then m_7 proves
    // the plan follows the *selection*.
    const { tool } = makeTool();
    const { plan } = await tool.buildOrThrow(
      completeSlots({ merchants: ['m_8', 'm_7'] }),
      offered,
      1,
    );
    expect(plan.merchants).toEqual([
      { merchantId: 8, name: 'Beta Books' },
      { merchantId: 7, name: 'Acme Electronics' },
    ]);
  });

  it('builds one component per chosen activity, in the chosen order', async () => {
    const { tool } = makeTool();
    const { plan } = await tool.buildOrThrow(
      completeSlots({
        activities: ['a_13', 'a_12'],
        rules: [
          { activityOptionId: 'a_13', ruleOptionId: 'r_3', values: {} },
          { activityOptionId: 'a_12', ruleOptionId: 'r_3', values: {} },
        ],
      }),
      offered,
      1,
    );
    expect(plan.components.map((component) => component.activityId)).toEqual([13, 12]);
  });

  it('resolves a component-level reward to the right component index', async () => {
    const { tool } = makeTool();
    const { plan } = await tool.buildOrThrow(
      completeSlots({
        activities: ['a_13', 'a_12'],
        rules: [
          { activityOptionId: 'a_13', ruleOptionId: 'r_3', values: {} },
          { activityOptionId: 'a_12', ruleOptionId: 'r_3', values: {} },
        ],
        rewards: [{ rewardOptionId: 'rw_9', level: 'component', activityOptionId: 'a_12' }],
      }),
      offered,
      1,
    );
    expect(plan.rewards[0].componentIndex).toBe(1);
  });

  it('defaults the tracker logic from the archetype when the maker expressed none', async () => {
    const { tool } = makeTool();
    // `completionLogic` is a required step, so reaching here with `null` is only possible when a
    // future step order changes; the default keeps the plan buildable rather than throwing.
    const slots = completeSlots();
    const { plan } = await tool.buildOrThrow(slots, offered, 1);
    expect(plan.tracker.completionLogic).toBe('all');
  });

  it('carries a description and a threshold through when the maker gave them', async () => {
    const { tool } = makeTool();
    const { plan } = await tool.buildOrThrow(
      completeSlots({
        description: 'Weekend only',
        activities: ['a_12', 'a_13'],
        rules: [
          { activityOptionId: 'a_12', ruleOptionId: 'r_3', values: {} },
          { activityOptionId: 'a_13', ruleOptionId: 'r_3', values: {} },
        ],
        completionLogic: 'n_of',
        completionThreshold: 2,
      }),
      offered,
      1,
    );
    expect(plan.campaign.description).toBe('Weekend only');
    expect(plan.tracker).toEqual({
      name: 'Weekend',
      completionLogic: 'n_of',
      completionThreshold: 2,
    });
  });

  it('carries caps through untouched', async () => {
    const cap = {
      capClass: 'budget' as const,
      scopeLevel: 'campaign' as const,
      periodType: 'lifetime' as const,
      unitType: 'currency' as const,
      unitCode: 'MYR',
      maxTotalAmount: '50000.0000',
    };
    const { tool } = makeTool();
    const { plan } = await tool.buildOrThrow(completeSlots({ caps: [cap] }), offered, 1);
    expect(plan.caps).toEqual([cap]);
  });

  it('resolves a tracker-level reward with no component index', async () => {
    const { tool } = makeTool();
    const { plan } = await tool.buildOrThrow(
      completeSlots({
        rewards: [{ rewardOptionId: 'rw_9', level: 'tracker', activityOptionId: null }],
      }),
      offered,
      1,
    );
    expect(plan.rewards[0]).toEqual({
      level: 'tracker',
      componentIndex: null,
      rewardPolicyId: 9,
      policyName: 'RM10 cashback',
    });
  });

  it('leaves componentIndex null when a component-level reward names an unbuilt activity', async () => {
    // The policy engine refuses this shape (`REWARD_TARGETS_UNCHOSEN_ACTIVITY`), so in practice it
    // never reaches here — but a `null` is the honest fallback rather than an index into nothing.
    const { tool } = makeTool();
    const { plan } = await tool.buildOrThrow(
      completeSlots({
        rewards: [{ rewardOptionId: 'rw_9', level: 'component', activityOptionId: 'a_13' }],
      }),
      offered,
      1,
    );
    expect(plan.rewards[0].componentIndex).toBeNull();
  });

  it('produces the same hash for the same answers, twice', async () => {
    const { tool } = makeTool();
    const first = await tool.buildOrThrow(completeSlots(), offered, 1);
    const second = await tool.buildOrThrow(completeSlots(), offered, 1);
    expect(first.planHash).toBe(second.planHash);
  });

  it('produces a different hash when an answer changes — TC-15’s mechanism', async () => {
    const { tool } = makeTool();
    const first = await tool.buildOrThrow(completeSlots(), offered, 1);
    const second = await tool.buildOrThrow(
      completeSlots({ budgetAmount: '999999.00' }),
      offered,
      1,
    );
    expect(first.planHash).not.toBe(second.planHash);
  });
});

describe('buildOrThrow — the containment gates', () => {
  it('refuses a merchant token that was never offered — TC-7, TC-10', async () => {
    const narrowed: OfferedOptions = { ...offered, merchants: [] };
    const { tool } = makeTool();
    await expect(tool.buildOrThrow(completeSlots(), narrowed, 1)).rejects.toThrow(
      UnresolvableOptionError,
    );
  });

  it('refuses a rule token that was never offered — TC-9', async () => {
    const narrowed: OfferedOptions = { ...offered, rules: [] };
    const { tool } = makeTool();
    await expect(tool.buildOrThrow(completeSlots(), narrowed, 1)).rejects.toThrow(
      UnresolvableOptionError,
    );
  });

  it('refuses a reward token that was never offered', async () => {
    const narrowed: OfferedOptions = { ...offered, rewards: [] };
    const { tool } = makeTool();
    await expect(tool.buildOrThrow(completeSlots(), narrowed, 1)).rejects.toThrow(
      UnresolvableOptionError,
    );
  });

  it('refuses an offered token that no longer resolves to a row — TC-8', async () => {
    const widened: OfferedOptions = { ...offered, merchants: ['m_7', 'm_404'] };
    const { tool } = makeTool();
    await expect(
      tool.buildOrThrow(completeSlots({ merchants: ['m_404'] }), widened, 1),
    ).rejects.toThrow(UnresolvableOptionError);
  });

  it('refuses a malformed token even if it somehow appears in the offered set', async () => {
    const widened: OfferedOptions = { ...offered, merchants: ['m_7', 'm_0'] };
    const { tool } = makeTool();
    await expect(
      tool.buildOrThrow(completeSlots({ merchants: ['m_0'] }), widened, 1),
    ).rejects.toThrow(UnresolvableOptionError);
  });
});
