import { activeCampaigns, buildCampaignProgress, ensureEnrolled } from './campaign-sync';
import { ProgressStore, type CampaignProgress } from './progress';
import type { PortalDataSource } from '../engine';
import type { PortalCampaign, PortalCampaignJourney } from '../portal-client/types';

const ACTIVE_CAMPAIGN: PortalCampaign = {
  id: 1,
  campaignCode: 'ACTIVE_ONE',
  name: 'Active One',
  description: null,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  status: 'active',
  tenantId: 1,
};

const PAUSED_CAMPAIGN: PortalCampaign = {
  ...ACTIVE_CAMPAIGN,
  id: 2,
  campaignCode: 'PAUSED_ONE',
  name: 'Paused One',
  status: 'paused',
};

const JOURNEY: PortalCampaignJourney = {
  campaignId: 1,
  trackers: [
    {
      id: 7,
      trackerCode: 'TRK',
      name: 'Tracker',
      description: null,
      completionLogic: 'all',
      completionThreshold: null,
      isPrimary: true,
      status: 'active',
      components: [
        {
          id: 71,
          componentCode: 'C1',
          name: 'Component 1',
          description: null,
          activityId: 5,
          activityName: 'Activity',
          sequenceOrder: 2,
          isMandatory: true,
          status: 'active',
        },
        {
          id: 72,
          componentCode: 'C2',
          name: 'Component 2',
          description: null,
          activityId: 6,
          activityName: 'Activity 2',
          sequenceOrder: 1,
          isMandatory: true,
          status: 'active',
        },
      ],
      rewards: [],
    },
  ],
  campaignRewards: [],
};

function fakePortal(
  campaigns: readonly PortalCampaign[],
  journeys: Record<number, PortalCampaignJourney> = {},
): PortalDataSource {
  return {
    getCampaigns: async () => campaigns,
    getCampaignJourney: async (id: number) => {
      const journey = journeys[id];
      if (!journey) throw new Error(`no fixture journey for campaign ${id}`);
      return journey;
    },
  };
}

describe('buildCampaignProgress', () => {
  it('sorts components by sequenceOrder and marks the first `completedCount` complete', () => {
    const progress = buildCampaignProgress(ACTIVE_CAMPAIGN, JOURNEY, 1);
    const components = progress.trackers[0].components;
    expect(components.map((c) => c.componentId)).toEqual([72, 71]); // sequenceOrder 1 then 2
    expect(components[0].completed).toBe(true);
    expect(components[1].completed).toBe(false);
  });

  it('defaults to zero progress', () => {
    const progress = buildCampaignProgress(ACTIVE_CAMPAIGN, JOURNEY);
    expect(progress.trackers[0].components.every((c) => !c.completed)).toBe(true);
  });
});

describe('activeCampaigns', () => {
  it('filters out anything not status active', async () => {
    const portal = fakePortal([ACTIVE_CAMPAIGN, PAUSED_CAMPAIGN]);
    const result = await activeCampaigns(portal);
    expect(result).toEqual([ACTIVE_CAMPAIGN]);
  });
});

describe('ensureEnrolled', () => {
  it('enrolls a customer with no prior progress in every active campaign, at zero progress', async () => {
    const portal = fakePortal([ACTIVE_CAMPAIGN], { 1: JOURNEY });
    const progress = new ProgressStore();

    await ensureEnrolled(portal, progress, 'new-customer');

    const stored = progress.getForCustomer('new-customer');
    expect(stored).toHaveLength(1);
    expect(stored[0].campaignId).toBe(1);
    expect(stored[0].trackers[0].components.every((c) => !c.completed)).toBe(true);
  });

  it('never overwrites an existing entry for a campaign the customer already has', async () => {
    const portal = fakePortal([ACTIVE_CAMPAIGN], { 1: JOURNEY });
    const progress = new ProgressStore();
    const existing: CampaignProgress = {
      campaignId: 1,
      campaignCode: 'ACTIVE_ONE',
      campaignName: 'Active One',
      trackers: [
        {
          trackerId: 7,
          trackerCode: 'TRK',
          trackerName: 'Tracker',
          completionLogic: 'all',
          completionThreshold: null,
          components: [],
        },
      ],
    };
    progress.setForCustomer('priya-shah', [existing]);

    await ensureEnrolled(portal, progress, 'priya-shah');

    expect(progress.getForCustomer('priya-shah')).toEqual([existing]);
  });

  it('adds only the campaigns actually missing, once a customer has some but not all', async () => {
    const secondActive: PortalCampaign = { ...ACTIVE_CAMPAIGN, id: 3, campaignCode: 'NEWLY_ACTIVE' };
    const portal = fakePortal([ACTIVE_CAMPAIGN, secondActive], { 1: JOURNEY, 3: JOURNEY });
    const progress = new ProgressStore();
    progress.setForCustomer('priya-shah', [
      { campaignId: 1, campaignCode: 'ACTIVE_ONE', campaignName: 'Active One', trackers: [] },
    ]);

    await ensureEnrolled(portal, progress, 'priya-shah');

    const ids = progress.getForCustomer('priya-shah').map((c) => c.campaignId);
    expect(ids).toEqual([1, 3]);
  });

  it('does not enroll a customer in a campaign that is not active', async () => {
    const portal = fakePortal([PAUSED_CAMPAIGN]);
    const progress = new ProgressStore();

    await ensureEnrolled(portal, progress, 'new-customer');

    expect(progress.getForCustomer('new-customer')).toEqual([]);
  });
});
