/**
 * T-048 — Zone 3 (`portal-api.client.ts`), 10-AI-CAMPAIGN-AGENT.md §2.
 *
 * TC-5 (*"agent attempts a write outside the API client → not possible; no DB write path
 * exists"*) and TC-16 (*"agent tries to call `/submit` → not in the whitelist; campaign stays
 * draft"*) are both statements about what this class does **not** do, so they are asserted by
 * recording every call it makes to the four campaign services and checking the list.
 *
 * The services are stubbed here because what is under test is the *sequence and the arguments* —
 * that the maker's own `AuthenticatedUser` is passed through unchanged, that provenance reaches
 * `create`, that `submit` is never reached. That those services then enforce role, scope and
 * validation is T-037's own suite's claim, re-proved end to end by this task's e2e.
 */
import {
  PortalApiClient,
  PartialPlanExecutionError,
} from '@/modules/campaign-agent/portal-api.client';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { AgentPlan } from '@reward-portal/shared';

const actor: AuthenticatedUser = {
  userId: 11,
  sessionId: 'sess',
  role: 'maker',
  countryId: 1,
  tenantId: 2,
  merchantId: null,
  rbacVersion: 1,
  tokenId: 'tok',
  mustChangePassword: false,
};

const plan: AgentPlan = {
  archetype: 'deferred_reward',
  campaign: {
    campaignCode: 'WKND',
    name: 'Weekend cashback',
    description: null,
    // Calendar dates — what `plan.tool.ts` puts in a plan after T-065, and therefore what this
    // client forwards to `POST /campaigns` verbatim.
    startDate: '2027-01-01',
    endDate: '2027-01-31',
    budgetAmount: '50000.00',
    budgetCurrency: 'MYR',
  },
  merchants: [{ merchantId: 7, name: 'Acme' }],
  tracker: { name: 'Weekend', completionLogic: 'n_of', completionThreshold: 1 },
  components: [
    {
      name: 'Card payment',
      activityId: 12,
      activityName: 'Card payment',
      rules: [
        {
          ruleId: 3,
          ruleCode: 'MIN',
          ruleName: 'Minimum spend',
          ruleVersionId: null,
          ruleVersionNo: null,
          values: { minSpend: 50 },
        },
      ],
    },
  ],
  rewards: [{ level: 'campaign', componentIndex: null, rewardPolicyId: 9, policyName: 'RM10' }],
  caps: [],
};

interface Recorded {
  method: string;
  args: unknown[];
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const calls: Recorded[] = [];
  const record =
    (method: string, result: unknown = undefined) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  const campaigns = {
    create: jest.fn(record('create', { id: 101, campaignCode: 'WKND' })),
    setMerchants: jest.fn(record('setMerchants', [])),
    loadEditableCampaign: jest.fn(record('loadEditableCampaign', { id: 101, tenantId: 2 })),
    getById: jest.fn(record('getById', { id: 101, campaignCode: 'WKND', status: 'draft' })),
    // Present on the stub precisely so the test can prove it is never called (TC-16).
    submit: jest.fn(record('submit', {})),
    ...overrides,
  };
  const journey = {
    createTracker: jest.fn(record('createTracker', { id: 201 })),
    createComponent: jest.fn(record('createComponent', { component: { id: 301 }, link: {} })),
  };
  const bindings = {
    bindRule: jest.fn(record('bindRule', { id: 401 })),
    attachReward: jest.fn(record('attachReward', 501)),
  };
  const caps = { put: jest.fn(record('caps.put', {})) };

  const client = new PortalApiClient(
    campaigns as never,
    journey as never,
    bindings as never,
    caps as never,
  );
  return { client, calls, campaigns, journey, bindings, caps };
}

describe('createCampaignDraft — the wizard’s own calls, in the wizard’s own order', () => {
  it('walks steps 1→6 and stops', async () => {
    const { client, calls } = makeClient();

    const campaign = await client.createCampaignDraft(actor, plan, 'session-uuid');

    expect(calls.map((call) => call.method)).toEqual([
      'create',
      'setMerchants',
      'loadEditableCampaign',
      'createTracker',
      'loadEditableCampaign',
      'createComponent',
      'loadEditableCampaign',
      'bindRule',
      'loadEditableCampaign',
      'attachReward',
      'getById',
    ]);
    expect(campaign).toMatchObject({ id: 101, status: 'draft' });
  });

  it('never calls submit — the agent stops at draft (TC-16, §3.2)', async () => {
    const { client, campaigns } = makeClient();
    await client.createCampaignDraft(actor, plan, 'session-uuid');
    expect(campaigns.submit).not.toHaveBeenCalled();
  });

  it('passes the maker’s own actor to every call — there is no service account (§2)', async () => {
    const { client, calls } = makeClient();
    await client.createCampaignDraft(actor, plan, 'session-uuid');

    const actorCarrying = calls.filter((call) =>
      [
        'create',
        'setMerchants',
        'createTracker',
        'createComponent',
        'bindRule',
        'attachReward',
      ].includes(call.method),
    );
    expect(actorCarrying.length).toBeGreaterThan(0);
    for (const call of actorCarrying) {
      expect(call.args[0]).toBe(actor);
    }
  });

  it('records the AI provenance on the create call — §7, TC-3', async () => {
    const { client, campaigns } = makeClient();
    await client.createCampaignDraft(actor, plan, 'session-uuid');

    expect(campaigns.create).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ campaignCode: 'WKND', name: 'Weekend cashback' }),
      { createdVia: 'ai_agent', agentSessionId: 'session-uuid' },
    );
  });

  it('omits absent optional fields rather than sending null, matching the DTO', async () => {
    const { client, campaigns } = makeClient();
    const bare: AgentPlan = {
      ...plan,
      campaign: { ...plan.campaign, budgetAmount: null, budgetCurrency: null },
    };
    await client.createCampaignDraft(actor, bare, 'session-uuid');

    const dto = campaigns.create.mock.calls[0][1] as Record<string, unknown>;
    expect('budgetAmount' in dto).toBe(false);
    expect('budgetCurrency' in dto).toBe(false);
    expect('description' in dto).toBe(false);
  });

  it('sets the merchants from the plan, wholesale', async () => {
    const { client, campaigns } = makeClient();
    await client.createCampaignDraft(actor, plan, 'session-uuid');
    expect(campaigns.setMerchants).toHaveBeenCalledWith(actor, 101, { merchantIds: [7] });
  });

  it('creates the tracker with its threshold, and omits it when there is none', async () => {
    const { client, journey } = makeClient();
    await client.createCampaignDraft(actor, plan, 'session-uuid');
    expect(journey.createTracker).toHaveBeenCalledWith(actor, expect.anything(), {
      name: 'Weekend',
      completionLogic: 'n_of',
      completionThreshold: 1,
    });

    const { client: client2, journey: journey2 } = makeClient();
    await client2.createCampaignDraft(
      actor,
      { ...plan, tracker: { ...plan.tracker, completionLogic: 'all', completionThreshold: null } },
      'session-uuid',
    );
    expect(journey2.createTracker).toHaveBeenCalledWith(actor, expect.anything(), {
      name: 'Weekend',
      completionLogic: 'all',
    });
  });

  it('binds each rule to the component it belongs to, with its values', async () => {
    const { client, bindings } = makeClient();
    await client.createCampaignDraft(actor, plan, 'session-uuid');
    expect(bindings.bindRule).toHaveBeenCalledWith(actor, expect.anything(), {
      componentId: 301,
      ruleId: 3,
      values: { minSpend: 50 },
    });
  });

  it('attaches a campaign-level reward with no refId', async () => {
    const { client, bindings } = makeClient();
    await client.createCampaignDraft(actor, plan, 'session-uuid');
    expect(bindings.attachReward).toHaveBeenCalledWith(actor, expect.anything(), {
      level: 'campaign',
      rewardPolicyId: 9,
    });
  });

  it('attaches a tracker-level reward to the tracker it just created', async () => {
    const { client, bindings } = makeClient();
    await client.createCampaignDraft(
      actor,
      {
        ...plan,
        rewards: [{ level: 'tracker', componentIndex: null, rewardPolicyId: 9, policyName: 'x' }],
      },
      'session-uuid',
    );
    expect(bindings.attachReward).toHaveBeenCalledWith(actor, expect.anything(), {
      level: 'tracker',
      refId: 201,
      rewardPolicyId: 9,
    });
  });

  it('attaches a component-level reward to the component the index names', async () => {
    const { client, bindings } = makeClient();
    await client.createCampaignDraft(
      actor,
      {
        ...plan,
        rewards: [{ level: 'component', componentIndex: 0, rewardPolicyId: 9, policyName: 'x' }],
      },
      'session-uuid',
    );
    expect(bindings.attachReward).toHaveBeenCalledWith(actor, expect.anything(), {
      level: 'component',
      refId: 301,
      rewardPolicyId: 9,
    });
  });

  it('skips the caps call entirely when the plan has none', async () => {
    const { client, caps } = makeClient();
    await client.createCampaignDraft(actor, plan, 'session-uuid');
    expect(caps.put).not.toHaveBeenCalled();
  });

  it('writes caps when the plan has them, and never asserts a currency confirmation (TC-21bb)', async () => {
    const { client, caps } = makeClient();
    const cap = {
      capClass: 'budget' as const,
      scopeLevel: 'campaign' as const,
      periodType: 'lifetime' as const,
      unitType: 'currency' as const,
      unitCode: 'MYR',
      maxTotalAmount: '50000.0000',
    };
    await client.createCampaignDraft(actor, { ...plan, caps: [cap] }, 'session-uuid');

    expect(caps.put).toHaveBeenCalledWith(actor, expect.anything(), { caps: [cap] });
    const dto = caps.put.mock.calls[0][2] as Record<string, unknown>;
    // Consenting on the maker's behalf is exactly what the agent must not do.
    expect('confirmCurrencyMismatch' in dto).toBe(false);
  });

  it('re-loads the campaign before each write, so scope and editability are re-checked', async () => {
    const { client, campaigns } = makeClient();
    await client.createCampaignDraft(actor, plan, 'session-uuid');
    expect(campaigns.loadEditableCampaign.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});

describe('partial failure', () => {
  it('names the step and keeps the campaign id, so the draft is not orphaned', async () => {
    const { client } = makeClient();
    const failing = makeClient();
    failing.bindings.bindRule.mockRejectedValueOnce(new Error('rule value out of range'));

    await expect(
      failing.client.createCampaignDraft(actor, plan, 'session-uuid'),
    ).rejects.toMatchObject({
      code: 'AGENT_PLAN_PARTIALLY_APPLIED',
      status: 502,
      campaignId: 101,
      step: 'component[0].rule[0]',
    });
    void client;
  });

  it('keeps the original error as the cause for the operator, not for the client', async () => {
    const failing = makeClient();
    const cause = new Error('duplicate reward');
    failing.bindings.attachReward.mockRejectedValueOnce(cause);

    const error = await failing.client
      .createCampaignDraft(actor, plan, 'session-uuid')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PartialPlanExecutionError);
    expect((error as { cause?: unknown }).cause).toBe(cause);
    // The message a client sees comes from the code, never from this sentence.
    expect((error as PartialPlanExecutionError).code).toBe('AGENT_PLAN_PARTIALLY_APPLIED');
  });

  it('stops at the failing step rather than pressing on', async () => {
    const failing = makeClient();
    failing.journey.createTracker.mockRejectedValueOnce(new Error('nope'));

    await expect(failing.client.createCampaignDraft(actor, plan, 'session-uuid')).rejects.toThrow();
    expect(failing.journey.createComponent).not.toHaveBeenCalled();
    expect(failing.bindings.bindRule).not.toHaveBeenCalled();
    expect(failing.campaigns.submit).not.toHaveBeenCalled();
  });
});
