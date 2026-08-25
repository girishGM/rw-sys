/**
 * T-048 — the slot state machine (`agent.state.ts`).
 *
 * These are the tests that pin down what "complete" means. Everything downstream — the plan
 * builder, the policy engine, the confirm gate — refuses to run while {@link missingSlots} is
 * non-empty, so a wrong answer here is a campaign created with a piece missing.
 */
import {
  applySlotPatch,
  emptySlots,
  isComplete,
  madeProgress,
  missingSlots,
  nextStep,
  slotPatchSchema,
  agentSlotsSchema,
  type AgentSlots,
} from '@/modules/campaign-agent/agent.state';

function filled(overrides: Partial<AgentSlots> = {}): AgentSlots {
  return {
    ...emptySlots(),
    archetype: 'instant_reward',
    name: 'Weekend cashback',
    campaignCode: 'WKND_CASH',
    startDate: '2026-09-01T00:00:00+08:00',
    endDate: '2026-09-30T00:00:00+08:00',
    budgetAmount: '50000.00',
    budgetCurrency: 'MYR',
    merchants: ['m_1'],
    activities: ['a_1'],
    trackerName: 'Weekend',
    completionLogic: 'all',
    rules: [{ activityOptionId: 'a_1', ruleOptionId: 'r_1', values: { minSpend: 50 } }],
    rewards: [{ rewardOptionId: 'rw_1', level: 'campaign', activityOptionId: null }],
    ...overrides,
  };
}

describe('emptySlots / missingSlots', () => {
  it('an empty store is missing every step, in the order §4 asks them', () => {
    expect(missingSlots(emptySlots())).toEqual([
      'archetype',
      'name',
      'campaignCode',
      'startDate',
      'endDate',
      'budget',
      'merchants',
      'activities',
      'tracker',
      'rewards',
    ]);
  });

  it('a fully answered store is complete', () => {
    expect(missingSlots(filled())).toEqual([]);
    expect(isComplete(filled())).toBe(true);
  });

  it('a budget amount without a currency is not an answer', () => {
    expect(missingSlots(filled({ budgetCurrency: null }))).toContain('budget');
  });

  it('an activity with no rule leaves the rules step outstanding', () => {
    // `COMPONENT_HAS_NO_RULE` would refuse the submission (T-037's structural validation); the
    // agent asks during the conversation instead of letting the maker find out at step 7.
    expect(missingSlots(filled({ rules: [] }))).toContain('rules');
  });

  it('a rule attached to a different activity does not satisfy that activity', () => {
    const slots = filled({
      activities: ['a_1', 'a_2'],
      rules: [{ activityOptionId: 'a_1', ruleOptionId: 'r_1', values: {} }],
    });
    expect(missingSlots(slots)).toContain('rules');
  });

  it('no reward at all leaves the rewards step outstanding', () => {
    expect(missingSlots(filled({ rewards: [] }))).toContain('rewards');
  });

  it('caps are deliberately not a required step (11-BUDGETS-AND-LIMITS §8.5)', () => {
    // A campaign with no cap row is a valid campaign — no ceiling means unlimited, not blocked.
    // The agent must not be stricter than the wizard it is a shortcut for.
    expect(isComplete(filled({ caps: [] }))).toBe(true);
  });
});

describe('nextStep', () => {
  it('names the first outstanding step', () => {
    expect(nextStep(emptySlots())).toMatch(/reward instantly/i);
    expect(nextStep(filled({ merchants: [] }))).toMatch(/merchants/i);
  });

  it('says the conversation is done once everything is answered', () => {
    expect(nextStep(filled())).toMatch(/review the plan/i);
  });
});

describe('applySlotPatch', () => {
  it('applies only the keys present, leaving the rest alone', () => {
    const before = emptySlots();
    const after = applySlotPatch(before, { name: 'Raya', campaignCode: 'RAYA26' });
    expect(after.name).toBe('Raya');
    expect(after.campaignCode).toBe('RAYA26');
    expect(after.merchants).toEqual([]);
  });

  it('does not mutate the input', () => {
    const before = emptySlots();
    applySlotPatch(before, { name: 'Raya' });
    expect(before.name).toBeNull();
  });
});

describe('slotPatchSchema — the only shape the model may propose', () => {
  it('rejects a key that is not a slot (TC-10, TC-11)', () => {
    // The canonical injection payload: something that names a tenant, an id or a table.
    expect(slotPatchSchema.safeParse({ tenantId: 9 }).success).toBe(false);
    expect(slotPatchSchema.safeParse({ sql: 'DROP TABLE tenant_campaigns' }).success).toBe(false);
    expect(slotPatchSchema.safeParse({ createdVia: 'human' }).success).toBe(false);
    expect(slotPatchSchema.safeParse({ status: 'active' }).success).toBe(false);
  });

  it('accepts a legitimate partial answer', () => {
    expect(slotPatchSchema.safeParse({ merchants: ['m_7'] }).success).toBe(true);
  });

  it('rejects a campaign code that would fail the portal’s own pattern', () => {
    expect(slotPatchSchema.safeParse({ campaignCode: 'no spaces allowed' }).success).toBe(false);
  });
});

describe('agentSlotsSchema — what a persisted row must satisfy', () => {
  it('round-trips an empty store', () => {
    expect(agentSlotsSchema.safeParse(emptySlots()).success).toBe(true);
  });

  it('rejects a stored row carrying an unknown key, rather than carrying it into a plan', () => {
    expect(agentSlotsSchema.safeParse({ ...emptySlots(), injected: true }).success).toBe(false);
  });
});

describe('madeProgress — §9’s stall detector', () => {
  it('is false when a turn changed nothing', () => {
    expect(madeProgress(emptySlots(), emptySlots())).toBe(false);
  });

  it('is true when an answer was replaced, not only when one was added', () => {
    const before = filled({ merchants: ['m_1'] });
    const after = filled({ merchants: ['m_2'] });
    expect(madeProgress(before, after)).toBe(true);
  });
});
