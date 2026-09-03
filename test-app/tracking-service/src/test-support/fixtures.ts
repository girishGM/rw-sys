/**
 * T-004 — self-contained fixture data for route/app tests, shaped exactly like real
 * `portal-client`/`data/progress.ts` output (field-for-field the same as the live 3-campaign demo
 * seed T-003 actually created — confirmed live against a running `portal/back-end` while
 * implementing this task) but with its own ids/codes, so tests never depend on a live portal
 * process or on that environment's specific numeric ids. Not itself a `.spec.ts` file — Jest's
 * `testRegex` never picks it up as a suite.
 */
import { ActivityHistoryStore } from '../data/activities';
import { CUSTOMERS } from '../data/customers';
import { ProgressStore, type CampaignProgress } from '../data/progress';
import { RewardsStore } from '../data/rewards';
import type { PortalDataSource } from '../engine';
import type { PortalCampaign, PortalCampaignJourney } from '../portal-client/types';

/** `FIXTURE_ALL`: one `all`-logic tracker, 2 components on 2 distinct activity types — exercises
 * TC-5/TC-6/TC-7 (only fires once *both* components are complete). `FIXTURE_NOF`: one `n_of`
 * tracker (threshold 2 of 3), all 3 components sharing one activity type — exercises TC-8,
 * including "no double award" once the threshold is already met. */
export const FIXTURE_ALL_CAMPAIGN_ID = 1001;
export const FIXTURE_NOF_CAMPAIGN_ID = 1002;

export const FIXTURE_CAMPAIGNS: readonly PortalCampaign[] = [
  {
    id: FIXTURE_ALL_CAMPAIGN_ID,
    campaignCode: 'FIXTURE_ALL',
    name: 'Fixture All-Logic Campaign',
    description: 'test fixture exercising completion_logic=all',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    status: 'active',
    tenantId: 1,
  },
  {
    id: FIXTURE_NOF_CAMPAIGN_ID,
    campaignCode: 'FIXTURE_NOF',
    name: 'Fixture N-of Campaign',
    description: 'test fixture exercising completion_logic=n_of',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    status: 'active',
    tenantId: 1,
  },
];

const FIXTURE_JOURNEYS = new Map<number, PortalCampaignJourney>([
  [
    FIXTURE_ALL_CAMPAIGN_ID,
    {
      campaignId: FIXTURE_ALL_CAMPAIGN_ID,
      trackers: [
        {
          id: 2001,
          trackerCode: 'ALL_TRACKER',
          name: 'All Tracker',
          description: null,
          completionLogic: 'all',
          completionThreshold: null,
          isPrimary: true,
          status: 'active',
          components: [
            {
              id: 3001,
              componentCode: 'COMP_A',
              name: 'Component A',
              description: null,
              activityId: 501,
              activityName: 'Grocery Purchase',
              sequenceOrder: 1,
              isMandatory: true,
              status: 'active',
            },
            {
              id: 3002,
              componentCode: 'COMP_B',
              name: 'Component B',
              description: null,
              activityId: 502,
              activityName: 'Weekend Transaction',
              sequenceOrder: 2,
              isMandatory: true,
              status: 'active',
            },
          ],
          rewards: [
            {
              id: 9001,
              level: 'tracker',
              refId: 2001,
              rewardPolicyId: 1,
              rewardPolicyName: 'Fixture Voucher Policy',
              rewardId: 1,
              rewardName: 'Fixture Voucher',
              unitType: 'voucher',
              unitCode: null,
              amount: null,
              promoCodeConfigId: null,
              status: 'active',
            },
          ],
        },
      ],
      campaignRewards: [],
    },
  ],
  [
    FIXTURE_NOF_CAMPAIGN_ID,
    {
      campaignId: FIXTURE_NOF_CAMPAIGN_ID,
      trackers: [
        {
          id: 2002,
          trackerCode: 'NOF_TRACKER',
          name: 'N-of Tracker',
          description: null,
          completionLogic: 'n_of',
          completionThreshold: 2,
          isPrimary: true,
          status: 'active',
          components: [
            {
              id: 3003,
              componentCode: 'COMP_C1',
              name: 'Component C1',
              description: null,
              activityId: 503,
              activityName: 'Refer a Friend',
              sequenceOrder: 1,
              isMandatory: false,
              status: 'active',
            },
            {
              id: 3004,
              componentCode: 'COMP_C2',
              name: 'Component C2',
              description: null,
              activityId: 503,
              activityName: 'Refer a Friend',
              sequenceOrder: 2,
              isMandatory: false,
              status: 'active',
            },
            {
              id: 3005,
              componentCode: 'COMP_C3',
              name: 'Component C3',
              description: null,
              activityId: 503,
              activityName: 'Refer a Friend',
              sequenceOrder: 3,
              isMandatory: false,
              status: 'active',
            },
          ],
          rewards: [
            {
              id: 9002,
              level: 'tracker',
              refId: 2002,
              rewardPolicyId: 2,
              rewardPolicyName: 'Fixture Points Policy',
              rewardId: 2,
              rewardName: 'Fixture Points',
              unitType: 'points',
              unitCode: 'PTS',
              amount: null,
              promoCodeConfigId: null,
              status: 'active',
            },
          ],
        },
      ],
      campaignRewards: [],
    },
  ],
]);

export class FakePortalDataSource implements PortalDataSource {
  async getCampaigns(): Promise<readonly PortalCampaign[]> {
    return FIXTURE_CAMPAIGNS;
  }

  async getCampaignJourney(campaignId: number): Promise<PortalCampaignJourney> {
    const journey = FIXTURE_JOURNEYS.get(campaignId);
    if (!journey) {
      throw new Error(`FakePortalDataSource: no fixture journey for campaign ${campaignId}`);
    }
    return journey;
  }
}

function buildInitialCampaignProgress(): readonly CampaignProgress[] {
  return [
    {
      campaignId: FIXTURE_ALL_CAMPAIGN_ID,
      campaignCode: 'FIXTURE_ALL',
      campaignName: 'Fixture All-Logic Campaign',
      trackers: [
        {
          trackerId: 2001,
          trackerCode: 'ALL_TRACKER',
          trackerName: 'All Tracker',
          completionLogic: 'all',
          completionThreshold: null,
          components: [
            {
              componentId: 3001,
              componentCode: 'COMP_A',
              componentName: 'Component A',
              completed: false,
            },
            {
              componentId: 3002,
              componentCode: 'COMP_B',
              componentName: 'Component B',
              completed: false,
            },
          ],
        },
      ],
    },
    {
      campaignId: FIXTURE_NOF_CAMPAIGN_ID,
      campaignCode: 'FIXTURE_NOF',
      campaignName: 'Fixture N-of Campaign',
      trackers: [
        {
          trackerId: 2002,
          trackerCode: 'NOF_TRACKER',
          trackerName: 'N-of Tracker',
          completionLogic: 'n_of',
          completionThreshold: 2,
          components: [
            {
              componentId: 3003,
              componentCode: 'COMP_C1',
              componentName: 'Component C1',
              completed: false,
            },
            {
              componentId: 3004,
              componentCode: 'COMP_C2',
              componentName: 'Component C2',
              completed: false,
            },
            {
              componentId: 3005,
              componentCode: 'COMP_C3',
              componentName: 'Component C3',
              completed: false,
            },
          ],
        },
      ],
    },
  ];
}

export interface FixtureStores {
  readonly progress: ProgressStore;
  readonly rewards: RewardsStore;
  /** T-013 — every `AppState` needs one; fixtures start empty, same as `rewards`. */
  readonly activities: ActivityHistoryStore;
  readonly portal: FakePortalDataSource;
  /** `null` — every route test spreads this straight into an `AppState` and exercises the
   * reward-minting *flow*, not promo-code-service's own generation (that's `engine/reward.spec.ts`,
   * against a fake `PromoCodeClient`); `null` here is the same "unconfigured" fallback path
   * `createPromoCodeClientFromEnv` produces for real when the env vars are unset. */
  readonly promoCode: null;
}

/** Every demo customer enrolled, zero progress, no rewards yet — the same starting shape
 * `data/seed.ts` builds for anyone but Priya Shah. */
export function buildFixtureStores(): FixtureStores {
  const progress = new ProgressStore();
  const rewards = new RewardsStore();
  const activities = new ActivityHistoryStore();
  for (const customer of CUSTOMERS) {
    progress.setForCustomer(customer.id, buildInitialCampaignProgress());
  }
  return { progress, rewards, activities, portal: new FakePortalDataSource(), promoCode: null };
}
