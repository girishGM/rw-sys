/**
 * T-049 — fixtures shared by this task's specs.
 *
 * Every object here is built to the **shared** contract type (`AgentTurn`, `AgentSessionDetail`,
 * `AgentPlan`, …), not to a hand-written test shape, so a wire-contract change that would break the
 * screen breaks these specs at compile time rather than at runtime in a browser.
 */
import type {
  AgentCreatedCampaign,
  AgentOptions,
  AgentPlan,
  AgentProgress,
  AgentSession,
  AgentSessionDetail,
  AgentTurn,
  Campaign,
} from '@reward-portal/shared';

export const SESSION_ID = '3f2a1c7e-0000-4000-8000-000000000001';

export const EMPTY_OPTIONS: AgentOptions = {
  merchants: [],
  activities: [],
  rules: [],
  rewards: [],
};

export function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: SESSION_ID,
    state: 'collecting',
    archetype: 'instant_reward',
    planHash: null,
    campaignId: null,
    campaignCode: null,
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T09:00:00.000Z',
    ...overrides,
  };
}

export function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
  return {
    missing: ['merchants', 'activities'],
    nextStep: 'Which merchants take part?',
    complete: false,
    offerWizard: false,
    ...overrides,
  };
}

export function turn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    session: session(),
    reply: 'Which merchants should take part?',
    options: EMPTY_OPTIONS,
    progress: progress(),
    plan: null,
    ...overrides,
  };
}

export function detail(overrides: Partial<AgentSessionDetail> = {}): AgentSessionDetail {
  return {
    session: session(),
    events: [
      {
        seq: 1,
        role: 'assistant',
        content: 'What should this campaign do?',
        at: '2026-08-20T09:00:00.000Z',
      },
      {
        seq: 2,
        role: 'user',
        content: 'A weekend cashback campaign',
        at: '2026-08-20T09:01:00.000Z',
      },
    ],
    options: EMPTY_OPTIONS,
    progress: progress(),
    plan: null,
    ...overrides,
  };
}

export const MERCHANT_OPTIONS: AgentOptions = {
  ...EMPTY_OPTIONS,
  merchants: [
    { optionId: 'm_12', label: 'Acme Electronics', subtitle: 'ACME-EL' },
    { optionId: 'm_13', label: 'TechWorld KL', subtitle: 'TW-KL' },
  ],
};

export const RULE_OPTIONS: AgentOptions = {
  ...EMPTY_OPTIONS,
  rules: [
    { optionId: 'r_7', label: 'Minimum spend tier', subtitle: 'MIN_SPEND_TIER · v3' },
    { optionId: 'r_8', label: 'Spend tier', subtitle: 'SPEND_TIER · v2' },
  ],
};

export function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    archetype: 'instant_reward',
    campaign: {
      campaignCode: 'RAYA-2026',
      name: 'Weekend Electronics Cashback',
      description: null,
      // T-065 — calendar dates. The plan is what the maker reads and what is hashed, and the
      // shared `agentPlanSchema` now refuses an instant here, so a fixture that carried one would
      // be a fixture describing a response the server can no longer send.
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      budgetAmount: '250000.00',
      budgetCurrency: 'MYR',
    },
    merchants: [
      { merchantId: 12, name: 'Acme Electronics' },
      { merchantId: 13, name: 'TechWorld KL' },
    ],
    tracker: { name: 'Weekend spend', completionLogic: 'all_of', completionThreshold: null },
    components: [
      {
        name: 'Purchase',
        activityId: 5,
        activityName: 'Purchase',
        rules: [
          {
            ruleId: 7,
            ruleCode: 'MIN_SPEND_TIER',
            ruleName: 'Minimum spend tier',
            ruleVersionId: null,
            ruleVersionNo: 3,
            values: { minSpend: 150, period: 'weekly' },
          },
        ],
      },
    ],
    rewards: [
      {
        level: 'campaign',
        componentIndex: null,
        rewardPolicyId: 4,
        policyName: 'CASHBACK_INSTANT',
      },
    ],
    caps: [],
    ...overrides,
  };
}

export function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 42,
    tenantId: 7,
    campaignCode: 'RAYA-2026',
    name: 'Weekend Electronics Cashback',
    description: null,
    // T-065 — `campaignSchema` serves calendar dates, so this is what a real response holds.
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    status: 'draft',
    effectiveStatus: 'draft',
    maxParticipants: null,
    budgetAmount: '250000.00',
    budgetCurrency: 'MYR',
    createdBy: 'aisha',
    approvedBy: null,
    approvedAt: null,
    lastReviewComment: null,
    editable: true,
    createdAt: '2026-08-20T09:10:00.000Z',
    updatedAt: '2026-08-20T09:10:00.000Z',
    ...overrides,
  };
}

export function created(overrides: Partial<AgentCreatedCampaign> = {}): AgentCreatedCampaign {
  return {
    session: session({ state: 'created', campaignId: 42, planHash: 'a'.repeat(64) }),
    campaign: campaign(),
    handOff: {
      message:
        'Created as draft RAYA-2026. Open it in the wizard to review it and submit it for approval — submitting is yours to do, not mine.',
      wizardPath: '/campaigns/42',
    },
    ...overrides,
  };
}
