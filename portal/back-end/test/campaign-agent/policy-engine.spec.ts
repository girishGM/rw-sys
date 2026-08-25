/**
 * T-048 — the deterministic policy engine (`policy-engine.service.ts`),
 * 10-AI-CAMPAIGN-AGENT.md §6.
 *
 * TC-17 (*"budget above the tenant ceiling"*) and TC-18 (*"`end_date` before `start_date`"*) live
 * here, together with the internal-reference checks that nothing downstream could have made yet.
 *
 * The model appears nowhere in this file, which is the point: §6 requires these decisions to be
 * *"decided by code, never by the model"*, and a suite that had to stub a model to reach them would
 * be evidence that they were not.
 */
import { PolicyEngineService } from '@/modules/campaign-agent/policy-engine.service';
import { ArchetypeRegistry } from '@/modules/campaign-agent/archetypes/archetype.registry';
import { emptySlots, type AgentSlots } from '@/modules/campaign-agent/agent.state';
import { TenantBudgetCeiling } from '@/database/models';

interface CeilingRow {
  unitType: string;
  unitCode: string;
  maxCampaignBudget: string;
  warnAboveAmount: string | null;
}

function makeEngine(ceilings: CeilingRow[] = []) {
  const listAll = jest.fn(async (model: unknown) =>
    model === TenantBudgetCeiling ? ceilings : [],
  );
  const engine = new PolicyEngineService(
    { listAll } as unknown as ConstructorParameters<typeof PolicyEngineService>[0],
    new ArchetypeRegistry(),
  );
  return { engine, listAll };
}

/** A slot store that is internally consistent, so a test can isolate one violation at a time. */
function slots(overrides: Partial<AgentSlots> = {}): AgentSlots {
  return {
    ...emptySlots(),
    archetype: 'instant_reward',
    startDate: futureIso(10),
    endDate: futureIso(40),
    merchants: ['m_1'],
    activities: ['a_1'],
    rules: [{ activityOptionId: 'a_1', ruleOptionId: 'r_1', values: {} }],
    rewards: [{ rewardOptionId: 'rw_1', level: 'campaign', activityOptionId: null }],
    ...overrides,
  };
}

function futureIso(days: number): string {
  return `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19)}Z`;
}

/** The calendar form the agent collects after T-065. Kept alongside {@link futureIso} rather than
 * replacing it, because the policy engine must go on accepting the instant form a model may still
 * volunteer — both are exercised. */
function futureDay(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function pastIso(days: number): string {
  return `${new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19)}Z`;
}

async function codes(engine: PolicyEngineService, value: AgentSlots): Promise<string[]> {
  const verdict = await engine.evaluate(value, 1);
  return verdict.violations.map((violation) => violation.code);
}

describe('temporal checks — TC-18', () => {
  it('accepts a well-ordered future window', async () => {
    const { engine } = makeEngine();
    const verdict = await engine.evaluate(slots(), 1);
    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it('refuses end before start — TC-18', async () => {
    const { engine } = makeEngine();
    expect(
      await codes(engine, slots({ startDate: futureIso(40), endDate: futureIso(10) })),
    ).toEqual(['DATE_ORDER']);
  });

  it('accepts end equal to start — a single-day campaign runs for one day (T-065)', async () => {
    // **Inverted from T-048's original assertion, deliberately** — see the same inversion in
    // `test/campaigns/dto.spec.ts`. A campaign date is now a calendar date whose end is the last
    // active day, *inclusive*, so `end == start` is a one-day campaign rather than a zero-length
    // one. The agent must accept exactly what the wizard accepts: 10-AI-CAMPAIGN-AGENT.md §1's
    // *"a bug in the agent cannot produce a campaign a human maker could not have produced by
    // hand"* cuts both ways — it must not refuse one a human maker could.
    const { engine } = makeEngine();
    const same = futureDay(10);
    expect(await codes(engine, slots({ startDate: same, endDate: same }))).toEqual([]);
  });

  it('T-065: accepts plain calendar dates, which is the form the agent now collects', async () => {
    const { engine } = makeEngine();
    expect(await codes(engine, slots({ startDate: futureDay(1), endDate: futureDay(30) }))).toEqual(
      [],
    );
  });

  it('refuses a start date already in the past', async () => {
    const { engine } = makeEngine();
    expect(await codes(engine, slots({ startDate: pastIso(5), endDate: futureIso(10) }))).toEqual([
      'DATE_START_IN_PAST',
    ]);
  });

  it('accepts a same-day start expressed in the maker’s own offset', async () => {
    // The bug this avoids: a Kuala Lumpur maker's "today" is eight hours in the past by UTC
    // reckoning, and a naive comparison would refuse an ordinary same-day campaign every morning.
    const { engine } = makeEngine();
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    const result = await codes(
      engine,
      slots({ startDate: `${today}T00:00:00+08:00`, endDate: futureIso(30) }),
    );
    expect(result).not.toContain('DATE_START_IN_PAST');
  });

  it('refuses a date with no offset, which is ambiguous about which day it means', async () => {
    const { engine } = makeEngine();
    const result = await codes(engine, slots({ startDate: '2027-01-01T00:00:00' }));
    expect(result).toEqual(['DATE_START_MALFORMED']);
  });

  it('reports both malformed dates at once rather than one per round trip', async () => {
    const { engine } = makeEngine();
    expect(await codes(engine, slots({ startDate: 'soon', endDate: 'later' }))).toEqual([
      'DATE_START_MALFORMED',
      'DATE_END_MALFORMED',
    ]);
  });

  it('skips the ordering check while a date is still unanswered', async () => {
    const { engine } = makeEngine();
    expect(await codes(engine, slots({ startDate: null, endDate: null }))).toEqual([]);
  });
});

describe('budget ceiling — TC-17', () => {
  it('refuses a budget above the tenant’s ceiling, naming the limit', async () => {
    const { engine } = makeEngine([
      {
        unitType: 'currency',
        unitCode: 'MYR',
        maxCampaignBudget: '100000.0000',
        warnAboveAmount: null,
      },
    ]);
    const verdict = await engine.evaluate(
      slots({ budgetAmount: '250000.00', budgetCurrency: 'MYR' }),
      1,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0].code).toBe('BUDGET_ABOVE_TENANT_CEILING');
    // §6: the model's job is to communicate the constraint, so the constraint has to be in the
    // message it is handed.
    expect(verdict.violations[0].message).toContain('100000.0000');
    expect(verdict.violations[0].message).toContain('250000.00');
  });

  it('accepts a budget exactly at the ceiling', async () => {
    const { engine } = makeEngine([
      {
        unitType: 'currency',
        unitCode: 'MYR',
        maxCampaignBudget: '100000.0000',
        warnAboveAmount: null,
      },
    ]);
    expect(
      await codes(engine, slots({ budgetAmount: '100000.00', budgetCurrency: 'MYR' })),
    ).toEqual([]);
  });

  it('treats no ceiling row as unlimited, not blocked (11-BUDGETS-AND-LIMITS §8.5)', async () => {
    const { engine } = makeEngine([]);
    expect(
      await codes(engine, slots({ budgetAmount: '999999999.00', budgetCurrency: 'MYR' })),
    ).toEqual([]);
  });

  it('does not apply another currency’s ceiling', async () => {
    const { engine } = makeEngine([
      {
        unitType: 'currency',
        unitCode: 'SGD',
        maxCampaignBudget: '10.0000',
        warnAboveAmount: null,
      },
    ]);
    expect(
      await codes(engine, slots({ budgetAmount: '100000.00', budgetCurrency: 'MYR' })),
    ).toEqual([]);
  });

  it('does not apply a points ceiling to a currency budget — there is no conversion rate', async () => {
    const { engine } = makeEngine([
      { unitType: 'points', unitCode: 'MYR', maxCampaignBudget: '1.0000', warnAboveAmount: null },
    ]);
    expect(await codes(engine, slots({ budgetAmount: '5000.00', budgetCurrency: 'MYR' }))).toEqual(
      [],
    );
  });

  it('skips the check while the budget is unanswered, without querying', async () => {
    const { engine, listAll } = makeEngine([]);
    await engine.evaluate(slots({ budgetAmount: null, budgetCurrency: null }), 1);
    expect(listAll).not.toHaveBeenCalled();
  });

  it('reads the ceiling for the tenant it was given, through ScopedRepository', async () => {
    const { engine, listAll } = makeEngine([]);
    await engine.evaluate(slots({ budgetAmount: '1.00', budgetCurrency: 'MYR' }), 42);
    expect(listAll).toHaveBeenCalledWith(
      TenantBudgetCeiling,
      expect.objectContaining({ where: { tenantId: 42, status: 'active' } }),
    );
  });

  it('does not refuse on an unparseable amount — a missing refusal beats a false one', async () => {
    const { engine } = makeEngine([
      {
        unitType: 'currency',
        unitCode: 'MYR',
        maxCampaignBudget: 'not-a-number',
        warnAboveAmount: null,
      },
    ]);
    expect(await codes(engine, slots({ budgetAmount: '1.00', budgetCurrency: 'MYR' }))).toEqual([]);
  });
});

describe('internal references — what nothing downstream has seen yet', () => {
  it('refuses a rule attached to an activity that is not in the campaign', async () => {
    const { engine } = makeEngine();
    const result = await codes(
      engine,
      slots({ rules: [{ activityOptionId: 'a_99', ruleOptionId: 'r_1', values: {} }] }),
    );
    expect(result).toContain('RULE_TARGETS_UNCHOSEN_ACTIVITY');
  });

  it('refuses a component-level reward with no activity named', async () => {
    const { engine } = makeEngine();
    const result = await codes(
      engine,
      slots({ rewards: [{ rewardOptionId: 'rw_1', level: 'component', activityOptionId: null }] }),
    );
    expect(result).toContain('REWARD_COMPONENT_WITHOUT_ACTIVITY');
  });

  it('refuses a component-level reward on an activity that is not in the campaign', async () => {
    const { engine } = makeEngine();
    const result = await codes(
      engine,
      slots({
        rewards: [{ rewardOptionId: 'rw_1', level: 'component', activityOptionId: 'a_99' }],
      }),
    );
    expect(result).toContain('REWARD_TARGETS_UNCHOSEN_ACTIVITY');
  });

  it('refuses a campaign-level reward that names an activity', async () => {
    const { engine } = makeEngine();
    const result = await codes(
      engine,
      slots({ rewards: [{ rewardOptionId: 'rw_1', level: 'campaign', activityOptionId: 'a_1' }] }),
    );
    expect(result).toContain('REWARD_LEVEL_MISMATCH');
  });

  it('refuses the same reward attached twice at the same place (uq_rca_*)', async () => {
    const { engine } = makeEngine();
    const result = await codes(
      engine,
      slots({
        rewards: [
          { rewardOptionId: 'rw_1', level: 'campaign', activityOptionId: null },
          { rewardOptionId: 'rw_1', level: 'campaign', activityOptionId: null },
        ],
      }),
    );
    expect(result).toContain('REWARD_ATTACHED_TWICE');
  });

  it('allows the same reward at two different levels', async () => {
    const { engine } = makeEngine();
    const result = await codes(
      engine,
      slots({
        rewards: [
          { rewardOptionId: 'rw_1', level: 'campaign', activityOptionId: null },
          { rewardOptionId: 'rw_1', level: 'component', activityOptionId: 'a_1' },
        ],
      }),
    );
    expect(result).toEqual([]);
  });
});

describe('archetype shape is delegated, not duplicated', () => {
  it('surfaces the archetype’s own violation', async () => {
    const { engine } = makeEngine();
    const result = await codes(
      engine,
      slots({
        archetype: 'instant_reward',
        activities: ['a_1', 'a_2'],
        rules: [
          { activityOptionId: 'a_1', ruleOptionId: 'r_1', values: {} },
          { activityOptionId: 'a_2', ruleOptionId: 'r_1', values: {} },
        ],
      }),
    );
    expect(result).toContain('INSTANT_REWARD_SINGLE_ACTIVITY');
  });

  it('skips the archetype check while the archetype is unanswered', async () => {
    const { engine } = makeEngine();
    expect(await codes(engine, slots({ archetype: null }))).toEqual([]);
  });
});
