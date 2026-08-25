/**
 * T-048 — the session lifecycle and the confirmation gate (`agent.service.ts`).
 *
 * TC-14 and TC-15 are here, and they are the two the task file singles out alongside TC-7/TC-10 as
 * *"the three that decide whether the containment actually works"*. So is TC-20's third
 * authorisation layer — the `assertRole` that holds even when the permission table says otherwise.
 */
import { AgentService } from '@/modules/campaign-agent/agent.service';
import { PlanHashService } from '@/modules/campaign-agent/plan-hash.service';
import {
  PlanHashMismatchError,
  PlanIncompleteError,
  SessionExhaustedError,
  SessionNotActiveError,
} from '@/modules/campaign-agent/agent.errors';
import { emptySlots } from '@/modules/campaign-agent/agent.state';
import { emptyOffered } from '@/modules/campaign-agent/option-resolver.service';
import { EMPTY_OPTIONS } from '@/modules/campaign-agent/agent.orchestrator';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { PortalRole } from '@/database/portal-models';
import type { AgentPlan } from '@reward-portal/shared';

function actorWith(role: PortalRole): AuthenticatedUser {
  return {
    userId: 11,
    sessionId: 'sess',
    role,
    countryId: 1,
    tenantId: 2,
    merchantId: null,
    rbacVersion: 1,
    tokenId: 'tok',
    mustChangePassword: false,
  };
}

const maker = actorWith('maker');

const plan: AgentPlan = {
  archetype: 'instant_reward',
  campaign: {
    campaignCode: 'WKND',
    name: 'Weekend cashback',
    description: null,
    // Calendar dates — what a plan carries after T-065.
    startDate: '2027-01-01',
    endDate: '2027-01-31',
    budgetAmount: '50000.00',
    budgetCurrency: 'MYR',
  },
  merchants: [{ merchantId: 7, name: 'Acme' }],
  tracker: { name: 'Weekend', completionLogic: 'all', completionThreshold: null },
  components: [{ name: 'Pay', activityId: 12, activityName: 'Pay', rules: [] }],
  rewards: [{ level: 'campaign', componentIndex: null, rewardPolicyId: 9, policyName: 'RM10' }],
  caps: [],
};

const hasher = new PlanHashService();
const planHash = hasher.hash(plan);

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-uuid',
    tenantId: 2,
    portalUserId: 11,
    state: 'collecting',
    slots: emptySlots(),
    offeredOptions: emptyOffered(),
    planHash: null,
    campaignId: null,
    noProgressTurns: 0,
    turnCount: 0,
    createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'),
    ...overrides,
  };
}

function makeService(overrides: Record<string, unknown> = {}) {
  const row = sessionRow(overrides['session'] as Record<string, unknown>);
  const sessions = {
    create: jest.fn(async () => row),
    findOwnOrFail: jest.fn(async () => row),
    listOwn: jest.fn(async () => [row]),
    saveTurn: jest.fn(async () => row),
    markCreated: jest.fn(async () => sessionRow({ state: 'created', campaignId: 101 })),
    markState: jest.fn(async () => sessionRow({ state: 'abandoned' })),
    appendEvent: jest.fn(
      async (_sessionId: string, _event: { role: string; content: string | null }) => undefined,
    ),
    listEvents: jest.fn(async () => [
      { seq: 1, role: 'user', content: 'hello', createdAt: new Date('2026-08-20T00:00:00Z') },
      { seq: 2, role: 'assistant', content: 'hi', createdAt: new Date('2026-08-20T00:00:01Z') },
    ]),
  };
  const orchestrator = {
    advance: jest.fn(async () => ({
      reply: 'Which merchants?',
      slots: emptySlots(),
      offered: emptyOffered(),
      options: EMPTY_OPTIONS,
      progress: { missing: ['archetype'], nextStep: 'x', complete: false, offerWizard: false },
      madeProgress: true,
    })),
    progressOf: jest.fn(() => ({
      missing: ['archetype'],
      nextStep: 'x',
      complete: false,
      offerWizard: false,
    })),
    explainViolations: jest.fn(async () => []),
  };
  const plans = { buildOrThrow: jest.fn(async () => ({ plan, planHash })) };
  const portal = {
    createCampaignDraft: jest.fn(async () => ({
      id: 101,
      campaignCode: 'WKND',
      status: 'draft',
    })),
  };

  const service = new AgentService(
    sessions as never,
    orchestrator as never,
    plans as never,
    hasher,
    portal as never,
  );
  return { service, sessions, orchestrator, plans, portal, row };
}

describe('the third authorisation layer — TC-20', () => {
  const methods: [string, (service: AgentService, actor: AuthenticatedUser) => Promise<unknown>][] =
    [
      ['start', (service, actor) => service.start(actor)],
      ['listOwn', (service, actor) => service.listOwn(actor)],
      ['resume', (service, actor) => service.resume(actor, 'session-uuid')],
      ['sendMessage', (service, actor) => service.sendMessage(actor, 'session-uuid', 'hi')],
      ['buildPlan', (service, actor) => service.buildPlan(actor, 'session-uuid')],
      ['confirm', (service, actor) => service.confirm(actor, 'session-uuid', planHash)],
      ['abandon', (service, actor) => service.abandon(actor, 'session-uuid')],
    ];

  it.each(methods)(
    '%s refuses a checker with 403, independent of the permission table',
    async (_name, call) => {
      const { service } = makeService();
      await expect(call(service, actorWith('checker'))).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(methods)('%s refuses a super_admin too — makers only', async (_name, call) => {
    const { service } = makeService();
    await expect(call(service, actorWith('super_admin'))).rejects.toMatchObject({ status: 403 });
  });

  it('a checker never reaches the session store at all', async () => {
    const { service, sessions } = makeService();
    await service.sendMessage(actorWith('checker'), 'session-uuid', 'hi').catch(() => undefined);
    expect(sessions.findOwnOrFail).not.toHaveBeenCalled();
  });
});

describe('start', () => {
  it('opens a session and records the greeting without calling the model', async () => {
    const { service, sessions, orchestrator } = makeService();

    const turn = await service.start(maker);

    expect(sessions.create).toHaveBeenCalled();
    expect(orchestrator.advance).not.toHaveBeenCalled();
    expect(turn.reply).toContain('draft');
    expect(sessions.appendEvent).toHaveBeenCalledWith('session-uuid', {
      role: 'assistant',
      content: turn.reply,
    });
  });
});

describe('sendMessage', () => {
  it('persists the maker’s message before consulting the model — TC-22', async () => {
    const { service, sessions, orchestrator } = makeService();
    const order: string[] = [];
    sessions.appendEvent.mockImplementation(async (_id: string, event: { role: string }) => {
      order.push(`event:${event.role}`);
    });
    orchestrator.advance.mockImplementation(async () => {
      order.push('model');
      return {
        reply: 'ok',
        slots: emptySlots(),
        offered: emptyOffered(),
        options: EMPTY_OPTIONS,
        progress: { missing: [], nextStep: '', complete: true, offerWizard: false },
        madeProgress: true,
      };
    });

    await service.sendMessage(maker, 'session-uuid', 'hello');

    expect(order).toEqual(['event:user', 'model', 'event:assistant']);
  });

  it('resets the stall counter on progress and increments it otherwise — TC-25', async () => {
    const { service, sessions, orchestrator } = makeService({
      session: { noProgressTurns: 2 },
    });
    orchestrator.advance.mockResolvedValueOnce({
      reply: 'ok',
      slots: emptySlots(),
      offered: emptyOffered(),
      options: EMPTY_OPTIONS,
      progress: { missing: [], nextStep: '', complete: false, offerWizard: false },
      madeProgress: false,
    } as never);

    const turn = await service.sendMessage(maker, 'session-uuid', 'hmm');

    expect(sessions.saveTurn).toHaveBeenCalledWith(
      'session-uuid',
      expect.objectContaining({ noProgressTurns: 3 }),
    );
    expect(turn.progress.offerWizard).toBe(true);
  });

  it('appends the policy engine’s explanations to the reply — §6', async () => {
    const { service, orchestrator } = makeService();
    orchestrator.explainViolations.mockResolvedValueOnce([
      'The campaign must end after it starts.',
    ] as never);

    const turn = await service.sendMessage(maker, 'session-uuid', 'hi');

    expect(turn.reply).toContain('Which merchants?');
    expect(turn.reply).toContain('The campaign must end after it starts.');
  });

  it('clears any previously-built plan, so a stale hash cannot be confirmed', async () => {
    const { service, sessions } = makeService({ session: { planHash: 'a'.repeat(64) } });
    await service.sendMessage(maker, 'session-uuid', 'hi');
    expect(sessions.saveTurn).toHaveBeenCalledWith(
      'session-uuid',
      expect.objectContaining({ plan: null, planHash: null }),
    );
  });

  it('refuses a session that has already produced a campaign', async () => {
    const { service } = makeService({ session: { state: 'created', campaignId: 101 } });
    await expect(service.sendMessage(maker, 'session-uuid', 'hi')).rejects.toThrow(
      SessionNotActiveError,
    );
  });

  it('refuses an abandoned session', async () => {
    const { service } = makeService({ session: { state: 'abandoned' } });
    await expect(service.sendMessage(maker, 'session-uuid', 'hi')).rejects.toThrow(
      SessionNotActiveError,
    );
  });

  it('refuses once the runaway guard is reached', async () => {
    const { service } = makeService({ session: { turnCount: 200 } });
    await expect(service.sendMessage(maker, 'session-uuid', 'hi')).rejects.toThrow(
      SessionExhaustedError,
    );
  });
});

describe('buildPlan — §4 step 9', () => {
  it('builds, hashes and moves the session to reviewing', async () => {
    const { service, sessions } = makeService();

    const turn = await service.buildPlan(maker, 'session-uuid');

    expect(turn.plan).toEqual(plan);
    expect(sessions.saveTurn).toHaveBeenCalledWith(
      'session-uuid',
      expect.objectContaining({ plan, planHash, state: 'reviewing' }),
    );
    expect(turn.session.planHash).toBe(planHash);
  });

  it('propagates a 422 for an incomplete conversation rather than a half plan', async () => {
    const { service, plans } = makeService();
    plans.buildOrThrow.mockRejectedValueOnce(new PlanIncompleteError(['merchants']));
    await expect(service.buildPlan(maker, 'session-uuid')).rejects.toThrow(PlanIncompleteError);
  });
});

describe('confirm — the hash gate (§3.2)', () => {
  it('creates the draft when the submitted hash matches the rebuilt plan', async () => {
    const { service, portal, sessions } = makeService();

    const result = await service.confirm(maker, 'session-uuid', planHash);

    expect(portal.createCampaignDraft).toHaveBeenCalledWith(maker, plan, 'session-uuid');
    expect(sessions.markCreated).toHaveBeenCalledWith('session-uuid', 101);
    expect(result.campaign).toMatchObject({ id: 101, status: 'draft' });
  });

  it('rebuilds the plan rather than trusting the stored one', async () => {
    const { service, plans } = makeService({ session: { planHash: 'stale'.padEnd(64, '0') } });
    await service.confirm(maker, 'session-uuid', planHash);
    expect(plans.buildOrThrow).toHaveBeenCalled();
  });

  it('rejects a hash that never matched, and creates nothing — TC-14', async () => {
    const { service, portal } = makeService();
    await expect(service.confirm(maker, 'session-uuid', 'b'.repeat(64))).rejects.toThrow(
      PlanHashMismatchError,
    );
    expect(portal.createCampaignDraft).not.toHaveBeenCalled();
  });

  it('rejects a hash that matched at display time but not now — TC-15', async () => {
    const { service, plans, portal } = makeService();
    // The maker held the hash from the review panel; an answer changed underneath, so the
    // rebuilt plan — and therefore its hash — is different.
    const mutated = { ...plan, campaign: { ...plan.campaign, budgetAmount: '999999.00' } };
    plans.buildOrThrow.mockResolvedValueOnce({ plan: mutated, planHash: hasher.hash(mutated) });

    await expect(service.confirm(maker, 'session-uuid', planHash)).rejects.toThrow(
      PlanHashMismatchError,
    );
    expect(portal.createCampaignDraft).not.toHaveBeenCalled();
  });

  it('records the rejection in the transcript, so a reviewer sees the attempt', async () => {
    const { service, sessions } = makeService();
    await service.confirm(maker, 'session-uuid', 'b'.repeat(64)).catch(() => undefined);
    expect(sessions.appendEvent).toHaveBeenCalledWith(
      'session-uuid',
      expect.objectContaining({ meta: { rejected: 'plan_hash_mismatch' } }),
    );
  });

  it('returns a hand-off that says submitting is the human’s job — TC-16', async () => {
    const { service } = makeService();
    const result = await service.confirm(maker, 'session-uuid', planHash);
    expect(result.handOff.message).toContain('draft WKND');
    expect(result.handOff.message).toMatch(/submitting is yours/i);
    expect(result.handOff.wizardPath).toBe('/campaigns/101');
  });

  it('refuses a session that already created a campaign — no second, unreviewed campaign', async () => {
    const { service } = makeService({ session: { state: 'created', campaignId: 101 } });
    await expect(service.confirm(maker, 'session-uuid', planHash)).rejects.toThrow(
      SessionNotActiveError,
    );
  });

  it('propagates a policy violation discovered at confirm time rather than executing', async () => {
    const { service, plans, portal } = makeService();
    plans.buildOrThrow.mockRejectedValueOnce(new PlanIncompleteError(['merchants']));
    await expect(service.confirm(maker, 'session-uuid', planHash)).rejects.toThrow(
      PlanIncompleteError,
    );
    expect(portal.createCampaignDraft).not.toHaveBeenCalled();
  });
});

describe('resume — TC-21, TC-22', () => {
  it('returns the state and the whole transcript in order', async () => {
    const { service } = makeService();

    const detail = await service.resume(maker, 'session-uuid');

    expect(detail.session.sessionId).toBe('session-uuid');
    expect(detail.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(detail.events[0]).toEqual({
      seq: 1,
      role: 'user',
      content: 'hello',
      at: '2026-08-20T00:00:00.000Z',
    });
  });

  it('includes the plan when the answers already support one', async () => {
    const { service } = makeService();
    const detail = await service.resume(maker, 'session-uuid');
    expect(detail.plan).toEqual(plan);
  });

  it('returns no plan mid-conversation, which is the normal case not an error', async () => {
    const { service, plans } = makeService();
    plans.buildOrThrow.mockRejectedValueOnce(new PlanIncompleteError(['merchants']));
    const detail = await service.resume(maker, 'session-uuid');
    expect(detail.plan).toBeNull();
  });

  it('returns no plan when the answers currently violate a policy', async () => {
    const { service, plans } = makeService();
    const violation = Object.assign(new Error('policy'), { code: 'AGENT_POLICY_VIOLATION' });
    plans.buildOrThrow.mockRejectedValueOnce(violation);
    const detail = await service.resume(maker, 'session-uuid');
    expect(detail.plan).toBeNull();
  });

  it('propagates anything that is not a "not ready" refusal', async () => {
    const { service, plans } = makeService();
    plans.buildOrThrow.mockRejectedValueOnce(new Error('the database is on fire'));
    await expect(service.resume(maker, 'session-uuid')).rejects.toThrow('the database is on fire');
  });

  it('does not replay a stale option list', async () => {
    const { service } = makeService();
    const detail = await service.resume(maker, 'session-uuid');
    expect(detail.options).toEqual(EMPTY_OPTIONS);
  });
});

describe('listOwn and abandon', () => {
  it('lists the maker’s own sessions', async () => {
    const { service } = makeService();
    const sessions = await service.listOwn(maker);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('session-uuid');
  });

  it('abandons an active session', async () => {
    const { service, sessions } = makeService();
    const result = await service.abandon(maker, 'session-uuid');
    expect(sessions.markState).toHaveBeenCalledWith('session-uuid', 'abandoned');
    expect(result.state).toBe('abandoned');
  });

  it('refuses to abandon a session that already produced a campaign', async () => {
    const { service } = makeService({ session: { state: 'created', campaignId: 101 } });
    await expect(service.abandon(maker, 'session-uuid')).rejects.toThrow(SessionNotActiveError);
  });
});
