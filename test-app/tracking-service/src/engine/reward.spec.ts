import { buildRewardForCompletedTracker, pickRewardAssignment } from './reward';
import type { PortalCampaign, PortalRewardAssignment } from '../portal-client/types';
import type { PromoCodeClient } from '../promo-code-client';
import type { GenerateCodeRequest, GenerateCodeResult } from '../promo-code-client';

const campaign: PortalCampaign = {
  id: 1001,
  campaignCode: 'FIXTURE_ALL',
  name: 'Fixture All-Logic Campaign',
  description: null,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  status: 'active',
  tenantId: 1,
};

function assignment(overrides: Partial<PortalRewardAssignment> = {}): PortalRewardAssignment {
  return {
    id: 9001,
    level: 'tracker',
    refId: 2001,
    rewardPolicyId: 1,
    rewardPolicyName: 'Fixture Policy',
    rewardId: 1,
    rewardName: 'Fixture Reward',
    unitType: 'voucher',
    unitCode: null,
    amount: null,
    promoCodeConfigId: null,
    status: 'active',
    ...overrides,
  };
}

/** A fake `PromoCodeClient` — same "inject a fake at the boundary" style
 * `portal-client/client.spec.ts` uses for `fetch`, one level up (the client itself, not its
 * transport), since `buildRewardForCompletedTracker` only ever calls `generateCode`. */
function fakeClient(
  impl: (request: GenerateCodeRequest) => Promise<GenerateCodeResult> | GenerateCodeResult,
): { client: PromoCodeClient; calls: GenerateCodeRequest[] } {
  const calls: GenerateCodeRequest[] = [];
  return {
    calls,
    client: {
      generateCode: async (request: GenerateCodeRequest) => {
        calls.push(request);
        return impl(request);
      },
    } as unknown as PromoCodeClient,
  };
}

const SUCCESS_RESULT: GenerateCodeResult = {
  status: 'SUCCESS',
  promoCodeId: 'pc-1',
  code: 'WELCOME20-XZ9K',
  rewardValueType: 'PERCENT_OFF',
  rewardValue: '20',
  rewardUnit: null,
  expiresAt: null,
  errorCode: null,
  errorMessage: null,
};

describe('pickRewardAssignment', () => {
  it('prefers the tracker-level assignment over a campaign-level one', () => {
    const trackerLevel = assignment({ id: 1 });
    const campaignLevel = assignment({ id: 2, level: 'campaign' });
    expect(pickRewardAssignment([trackerLevel], [campaignLevel])?.id).toBe(1);
  });

  it('falls back to a campaign-level assignment when the tracker has none', () => {
    const campaignLevel = assignment({ id: 2, level: 'campaign' });
    expect(pickRewardAssignment([], [campaignLevel])?.id).toBe(2);
  });

  it('skips an inactive assignment', () => {
    const inactive = assignment({ id: 1, status: 'withdrawn' });
    const active = assignment({ id: 2, level: 'campaign', status: 'active' });
    expect(pickRewardAssignment([inactive], [active])?.id).toBe(2);
  });

  it('returns null when nothing eligible exists at either level', () => {
    expect(pickRewardAssignment([], [])).toBeNull();
  });
});

describe('buildRewardForCompletedTracker', () => {
  it('derives type from the real unitType (voucher -> promo_code), invented fallback with no config/client', async () => {
    const reward = await buildRewardForCompletedTracker(
      'priya-shah',
      campaign,
      assignment({ unitType: 'voucher' }),
    );
    expect(reward.type).toBe('promo_code');
    expect(reward.value).toMatch(/^SAVE\d+$/);
    expect(reward.currency).toBeNull();
  });

  it('derives type from the real unitType (currency -> cashback) with an invented amount when none is real', async () => {
    const reward = await buildRewardForCompletedTracker(
      'priya-shah',
      campaign,
      assignment({ unitType: 'currency', amount: null }),
    );
    expect(reward.type).toBe('cashback');
    expect(reward.value).toBe('25.00');
    expect(reward.currency).toBe('USD');
  });

  it('uses a real amount over the invented fallback when one is present', async () => {
    const reward = await buildRewardForCompletedTracker(
      'priya-shah',
      campaign,
      assignment({ unitType: 'currency', amount: '42.50' }),
    );
    expect(reward.value).toBe('42.50');
  });

  it('derives type from the real unitType (points -> points)', async () => {
    const reward = await buildRewardForCompletedTracker(
      'priya-shah',
      campaign,
      assignment({ unitType: 'points' }),
    );
    expect(reward.type).toBe('points');
    expect(reward.value).toBe('500');
    expect(reward.currency).toBeNull();
  });

  it('always ties the ledger entry back to the real campaign, expiring with it', async () => {
    const reward = await buildRewardForCompletedTracker('priya-shah', campaign, assignment());
    expect(reward.campaignId).toBe(campaign.id);
    expect(reward.campaignCode).toBe(campaign.campaignCode);
    expect(reward.expiresAt).toBe(campaign.endDate);
    expect(reward.status).toBe('unused');
    expect(reward.customerId).toBe('priya-shah');
  });

  it('is deterministic given injected now/idGenerator/random (testability)', async () => {
    const fixedNow = new Date('2026-06-01T00:00:00.000Z');
    const reward = await buildRewardForCompletedTracker('priya-shah', campaign, assignment(), {
      now: () => fixedNow,
      idGenerator: () => 'fixed-id',
      random: () => 0,
    });
    expect(reward.id).toBe('fixed-id');
    expect(reward.issuedAt).toBe(fixedNow.toISOString());
    expect(reward.value).toBe('SAVE10');
  });

  describe('real promo-code-service generation', () => {
    it('uses the real code on a SUCCESS result, calling generateCode with the tracker binding', async () => {
      const { client, calls } = fakeClient(() => SUCCESS_RESULT);

      const reward = await buildRewardForCompletedTracker(
        'priya-shah',
        campaign,
        assignment({ level: 'tracker', refId: 2001, promoCodeConfigId: 'cfg-abc' }),
        { promoCodeClient: client },
      );

      expect(reward.value).toBe('WELCOME20-XZ9K');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        tenantId: '1',
        bindLevel: 'TRACKER',
        bindRefId: '2001',
        customerId: 'priya-shah',
      });
    });

    it('derives a CAMPAIGN bindRefId from the campaign id, since campaign-level assignments carry no refId', async () => {
      const { client, calls } = fakeClient(() => SUCCESS_RESULT);

      await buildRewardForCompletedTracker(
        'priya-shah',
        campaign,
        assignment({ level: 'campaign', refId: null, promoCodeConfigId: 'cfg-abc' }),
        { promoCodeClient: client },
      );

      expect(calls[0]).toMatchObject({ bindLevel: 'CAMPAIGN', bindRefId: String(campaign.id) });
    });

    it('never calls generateCode when the reward has no bound promoCodeConfigId', async () => {
      const { client, calls } = fakeClient(() => SUCCESS_RESULT);

      const reward = await buildRewardForCompletedTracker(
        'priya-shah',
        campaign,
        assignment({ promoCodeConfigId: null }),
        { promoCodeClient: client, random: () => 0 },
      );

      expect(calls).toHaveLength(0);
      expect(reward.value).toBe('SAVE10');
    });

    it('falls back to an invented code on a FAILED business outcome, without throwing', async () => {
      const { client } = fakeClient(() => ({
        status: 'FAILED',
        promoCodeId: null,
        code: null,
        rewardValueType: null,
        rewardValue: null,
        rewardUnit: null,
        expiresAt: null,
        errorCode: 'CONFIG_NOT_BOUND',
        errorMessage: 'no active binding',
      }));

      const reward = await buildRewardForCompletedTracker(
        'priya-shah',
        campaign,
        assignment({ promoCodeConfigId: 'cfg-abc' }),
        { promoCodeClient: client, random: () => 0 },
      );

      expect(reward.value).toBe('SAVE10');
    });

    it('falls back to an invented code when the call itself throws, without throwing', async () => {
      const { client } = fakeClient(() => {
        throw new Error('ECONNREFUSED');
      });

      const reward = await buildRewardForCompletedTracker(
        'priya-shah',
        campaign,
        assignment({ promoCodeConfigId: 'cfg-abc' }),
        { promoCodeClient: client, random: () => 0 },
      );

      expect(reward.value).toBe('SAVE10');
    });
  });
});
