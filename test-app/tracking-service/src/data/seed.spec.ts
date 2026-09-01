import type { PortalClient } from '../portal-client/client';
import type { PortalCampaign, PortalCampaignJourney } from '../portal-client/types';
import { isTrackerComplete } from './progress';
import { seedDemoData } from './seed';

const CAMPAIGNS: PortalCampaign[] = [
  {
    id: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    name: 'Summer Cashback Sprint',
    description: null,
    startDate: '2026-07-01',
    endDate: '2026-09-30',
    status: 'active',
  },
  {
    id: 2,
    campaignCode: 'REFER_AND_EARN',
    name: 'Refer & Earn',
    description: null,
    startDate: '2026-06-01',
    endDate: '2026-12-31',
    status: 'active',
  },
  {
    id: 3,
    campaignCode: 'WEEKEND_PROMO_BLITZ',
    name: 'Weekend Promo Blitz',
    description: null,
    startDate: '2026-08-15',
    endDate: '2026-09-15',
    status: 'active',
  },
];

function componentsOf(
  count: number,
  prefix: string,
): PortalCampaignJourney['trackers'][number]['components'] {
  return Array.from({ length: count }, (_, i) => ({
    id: 100 * count + i + 1,
    componentCode: `${prefix}_${i + 1}`,
    name: `${prefix} ${i + 1}`,
    description: null,
    activityId: 9,
    activityName: 'Activity',
    sequenceOrder: i + 1,
    isMandatory: false,
    status: 'active',
  }));
}

const JOURNEYS: Record<number, PortalCampaignJourney> = {
  1: {
    campaignId: 1,
    trackers: [
      {
        id: 11,
        trackerCode: 'SUMMER_PURCHASE_STREAK',
        name: 'Purchase Streak',
        description: null,
        completionLogic: 'n_of',
        completionThreshold: 5,
        isPrimary: true,
        status: 'active',
        components: componentsOf(5, 'SUMMER'),
        rewards: [],
      },
    ],
    campaignRewards: [],
  },
  2: {
    campaignId: 2,
    trackers: [
      {
        id: 12,
        trackerCode: 'REFER_PROGRESS',
        name: 'Referral Progress',
        description: null,
        completionLogic: 'n_of',
        completionThreshold: 3,
        isPrimary: true,
        status: 'active',
        components: componentsOf(3, 'REFER'),
        rewards: [],
      },
    ],
    campaignRewards: [],
  },
  3: {
    campaignId: 3,
    trackers: [
      {
        id: 13,
        trackerCode: 'WEEKEND_CHALLENGE',
        name: 'Weekend Challenge',
        description: null,
        completionLogic: 'all',
        completionThreshold: null,
        isPrimary: true,
        status: 'active',
        components: componentsOf(2, 'WEEKEND'),
        rewards: [
          {
            id: 900,
            level: 'tracker',
            refId: 13,
            rewardPolicyId: 462,
            rewardPolicyName: 'Promo Code Voucher',
            rewardId: 1376,
            rewardName: 'Promo Code Voucher',
            unitType: 'voucher',
            unitCode: null,
            amount: null,
            status: 'active',
          },
        ],
      },
    ],
    campaignRewards: [],
  },
};

function fakePortalClient(): PortalClient {
  return {
    getCampaigns: jest.fn().mockResolvedValue(CAMPAIGNS),
    getCampaignJourney: jest.fn((id: number) => Promise.resolve(JOURNEYS[id])),
  } as unknown as PortalClient;
}

describe('seedDemoData', () => {
  it('TC-7/TC-8: seeds Priya Shah at 3/5, 1/3 and a completed 2/2, using real tracker/component ids', async () => {
    const { progress, rewards } = await seedDemoData(fakePortalClient());

    const priya = progress.getForCustomer('priya-shah');
    expect(priya).toHaveLength(3);

    const summer = priya.find((c) => c.campaignCode === 'SUMMER_CASHBACK_SPRINT')!;
    expect(summer.trackers[0].trackerId).toBe(11); // real id, not invented
    expect(summer.trackers[0].components.filter((c) => c.completed)).toHaveLength(3);
    expect(summer.trackers[0].components).toHaveLength(5);

    const refer = priya.find((c) => c.campaignCode === 'REFER_AND_EARN')!;
    expect(refer.trackers[0].components.filter((c) => c.completed)).toHaveLength(1);

    const weekend = priya.find((c) => c.campaignCode === 'WEEKEND_PROMO_BLITZ')!;
    expect(isTrackerComplete(weekend.trackers[0])).toBe(true);

    const priyaRewards = rewards.getForCustomer('priya-shah');
    expect(priyaRewards).toEqual([
      {
        id: 'seed-priya-shah-save20',
        customerId: 'priya-shah',
        campaignId: 3,
        campaignCode: 'WEEKEND_PROMO_BLITZ',
        type: 'promo_code',
        value: 'SAVE20',
        currency: null,
        status: 'unused',
        issuedAt: '2026-08-15',
        expiresAt: '2026-09-15',
      },
    ]);
  });

  it('seeds the other 2 demo customers enrolled with zero progress and no rewards', async () => {
    const { progress, rewards } = await seedDemoData(fakePortalClient());

    for (const customerId of ['marcus-tan', 'aisha-rahman']) {
      const campaigns = progress.getForCustomer(customerId);
      expect(campaigns).toHaveLength(3);
      for (const campaign of campaigns) {
        for (const tracker of campaign.trackers) {
          expect(tracker.components.every((c) => !c.completed)).toBe(true);
        }
      }
      expect(rewards.getForCustomer(customerId)).toEqual([]);
    }
  });

  it('fails loudly if an expected demo campaign is missing from the portal', async () => {
    const client = {
      getCampaigns: jest.fn().mockResolvedValue(CAMPAIGNS.slice(0, 2)), // missing WEEKEND_PROMO_BLITZ
      getCampaignJourney: jest.fn(),
    } as unknown as PortalClient;

    await expect(seedDemoData(client)).rejects.toThrow(/WEEKEND_PROMO_BLITZ/);
  });
});
