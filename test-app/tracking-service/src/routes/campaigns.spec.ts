import request from 'supertest';
import { createApp } from '../app';
import { CUSTOMERS } from '../data/customers';
import {
  buildFixtureStores,
  FakePortalDataSource,
  FIXTURE_ALL_CAMPAIGN_ID,
  FIXTURE_CAMPAIGNS,
} from '../test-support/fixtures';
import type { PortalCampaign, PortalCampaignJourney } from '../portal-client/types';
import type { PortalDataSource } from '../engine';
import { SseHub, type AppState } from './index';

function buildState(portalOverride?: PortalDataSource): AppState {
  const stores = buildFixtureStores();
  return {
    customers: CUSTOMERS,
    ...stores,
    ...(portalOverride ? { portal: portalOverride } : {}),
    sse: new SseHub(),
  };
}

describe('GET /api/campaigns', () => {
  it('TC-3: returns real campaign data, unmerged when no customerId given', async () => {
    const response = await request(createApp(buildState())).get('/api/campaigns');

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    const allCampaign = response.body.data.find(
      (c: { campaignCode: string }) => c.campaignCode === 'FIXTURE_ALL',
    );
    expect(allCampaign.progress).toBeNull();
    expect(allCampaign.name).toBe('Fixture All-Logic Campaign');
  });

  it('TC-3: merges in the given customer’s progress when customerId is provided', async () => {
    const response = await request(createApp(buildState())).get(
      '/api/campaigns?customerId=priya-shah',
    );

    const allCampaign = response.body.data.find(
      (c: { campaignCode: string }) => c.campaignCode === 'FIXTURE_ALL',
    );
    expect(allCampaign.progress.trackers).toEqual([
      expect.objectContaining({
        trackerCode: 'ALL_TRACKER',
        completionLogic: 'all',
        completedCount: 0,
        threshold: 2,
        completed: false,
      }),
    ]);
  });

  it('4xx for an unknown customerId', async () => {
    const response = await request(createApp(buildState())).get('/api/campaigns?customerId=nobody');
    expect(response.status).toBe(404);
  });

  // `data/campaign-sync.ts` — this app no longer hardcodes which campaigns exist; a campaign the
  // portal reports active, that this customer has never been enrolled in before, must show up
  // with real, zeroed progress on the very next request, and one no longer active must stop
  // showing even though this customer still has an old `ProgressStore` row for it.
  describe('dynamic campaign sync', () => {
    const NEW_CAMPAIGN_ID = 9001;
    const NEW_CAMPAIGN: PortalCampaign = {
      id: NEW_CAMPAIGN_ID,
      campaignCode: 'BRAND_NEW_LAUNCH',
      name: 'Brand New Launch',
      description: null,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      status: 'active',
      tenantId: 1,
    };
    const NEW_JOURNEY: PortalCampaignJourney = {
      campaignId: NEW_CAMPAIGN_ID,
      trackers: [
        {
          id: 9101,
          trackerCode: 'NEW_TRACKER',
          name: 'New Tracker',
          description: null,
          completionLogic: 'all',
          completionThreshold: null,
          isPrimary: true,
          status: 'active',
          components: [
            {
              id: 9201,
              componentCode: 'NEW_COMP',
              name: 'New Component',
              description: null,
              activityId: 601,
              activityName: 'New Activity',
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

    it('a campaign activated after this customer was first seen appears with zero progress', async () => {
      const originalPortal = new FakePortalDataSource();
      const state = buildState({
        getCampaigns: async () => [...FIXTURE_CAMPAIGNS, NEW_CAMPAIGN],
        getCampaignJourney: async (id: number) =>
          id === NEW_CAMPAIGN_ID ? NEW_JOURNEY : originalPortal.getCampaignJourney(id),
      });

      const response = await request(createApp(state)).get(
        '/api/campaigns?customerId=priya-shah',
      );

      const launched = response.body.data.find(
        (c: { campaignCode: string }) => c.campaignCode === 'BRAND_NEW_LAUNCH',
      );
      expect(launched).toBeDefined();
      expect(launched.progress.trackers[0]).toEqual(
        expect.objectContaining({ trackerCode: 'NEW_TRACKER', completedCount: 0, completed: false }),
      );
    });

    it('a campaign no longer active stops appearing, even with existing progress on it', async () => {
      const originalPortal = new FakePortalDataSource();
      const state = buildState({
        getCampaigns: async () =>
          FIXTURE_CAMPAIGNS.map((c) =>
            c.campaignCode === 'FIXTURE_ALL' ? { ...c, status: 'paused' } : c,
          ),
        getCampaignJourney: (id: number) => originalPortal.getCampaignJourney(id),
      });

      const response = await request(createApp(state)).get(
        '/api/campaigns?customerId=priya-shah',
      );

      expect(
        response.body.data.find((c: { campaignCode: string }) => c.campaignCode === 'FIXTURE_ALL'),
      ).toBeUndefined();
    });
  });
});

describe('GET /api/campaigns/:code', () => {
  it('returns the real tracker/component tree for a known code', async () => {
    const response = await request(createApp(buildState())).get('/api/campaigns/FIXTURE_ALL');

    expect(response.status).toBe(200);
    expect(response.body.data.campaignId).toBe(FIXTURE_ALL_CAMPAIGN_ID);
    expect(response.body.data.trackers[0].components).toHaveLength(2);
    expect(response.body.data.trackers[0].components[0].completed).toBe(false);
  });

  it('merges completion state per component when customerId is provided', async () => {
    const state = buildState();
    state.progress.setComponentCompletion('priya-shah', FIXTURE_ALL_CAMPAIGN_ID, 2001, 3001, true);

    const response = await request(createApp(state)).get(
      '/api/campaigns/FIXTURE_ALL?customerId=priya-shah',
    );

    const [componentA, componentB] = response.body.data.trackers[0].components;
    expect(componentA.completed).toBe(true);
    expect(componentB.completed).toBe(false);
  });

  it('404 for an unknown campaign code', async () => {
    const response = await request(createApp(buildState())).get('/api/campaigns/NO_SUCH_CAMPAIGN');
    expect(response.status).toBe(404);
  });
});
