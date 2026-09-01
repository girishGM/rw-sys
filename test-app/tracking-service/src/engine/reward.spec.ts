import { buildRewardForCompletedTracker, pickRewardAssignment } from './reward';
import type { PortalCampaign, PortalRewardAssignment } from '../portal-client/types';

const campaign: PortalCampaign = {
  id: 1001,
  campaignCode: 'FIXTURE_ALL',
  name: 'Fixture All-Logic Campaign',
  description: null,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  status: 'active',
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
    status: 'active',
    ...overrides,
  };
}

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
  it('derives type from the real unitType (voucher -> promo_code)', () => {
    const reward = buildRewardForCompletedTracker(
      'priya-shah',
      campaign,
      assignment({ unitType: 'voucher' }),
    );
    expect(reward.type).toBe('promo_code');
    expect(reward.value).toMatch(/^SAVE\d+$/);
    expect(reward.currency).toBeNull();
  });

  it('derives type from the real unitType (currency -> cashback) with an invented amount when none is real', () => {
    const reward = buildRewardForCompletedTracker(
      'priya-shah',
      campaign,
      assignment({ unitType: 'currency', amount: null }),
    );
    expect(reward.type).toBe('cashback');
    expect(reward.value).toBe('25.00');
    expect(reward.currency).toBe('USD');
  });

  it('uses a real amount over the invented fallback when one is present', () => {
    const reward = buildRewardForCompletedTracker(
      'priya-shah',
      campaign,
      assignment({ unitType: 'currency', amount: '42.50' }),
    );
    expect(reward.value).toBe('42.50');
  });

  it('derives type from the real unitType (points -> points)', () => {
    const reward = buildRewardForCompletedTracker(
      'priya-shah',
      campaign,
      assignment({ unitType: 'points' }),
    );
    expect(reward.type).toBe('points');
    expect(reward.value).toBe('500');
    expect(reward.currency).toBeNull();
  });

  it('always ties the ledger entry back to the real campaign, expiring with it', () => {
    const reward = buildRewardForCompletedTracker('priya-shah', campaign, assignment());
    expect(reward.campaignId).toBe(campaign.id);
    expect(reward.campaignCode).toBe(campaign.campaignCode);
    expect(reward.expiresAt).toBe(campaign.endDate);
    expect(reward.status).toBe('unused');
    expect(reward.customerId).toBe('priya-shah');
  });

  it('is deterministic given injected now/idGenerator/random (testability)', () => {
    const fixedNow = new Date('2026-06-01T00:00:00.000Z');
    const reward = buildRewardForCompletedTracker('priya-shah', campaign, assignment(), {
      now: () => fixedNow,
      idGenerator: () => 'fixed-id',
      random: () => 0,
    });
    expect(reward.id).toBe('fixed-id');
    expect(reward.issuedAt).toBe(fixedNow.toISOString());
    expect(reward.value).toBe('SAVE10');
  });
});
