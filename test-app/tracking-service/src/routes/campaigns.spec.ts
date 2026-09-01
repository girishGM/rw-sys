import request from 'supertest';
import { createApp } from '../app';
import { CUSTOMERS } from '../data/customers';
import { buildFixtureStores, FIXTURE_ALL_CAMPAIGN_ID } from '../test-support/fixtures';
import { SseHub, type AppState } from './index';

function buildState(): AppState {
  return { customers: CUSTOMERS, ...buildFixtureStores(), sse: new SseHub() };
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
