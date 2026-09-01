import request from 'supertest';
import { createApp } from '../app';
import { CUSTOMERS } from '../data/customers';
import type { RewardLedgerEntry } from '../data/rewards';
import {
  buildFixtureStores,
  FIXTURE_ALL_CAMPAIGN_ID,
  FIXTURE_NOF_CAMPAIGN_ID,
} from '../test-support/fixtures';
import { SseHub, type AppState } from './index';

function buildState() {
  return { customers: CUSTOMERS, ...buildFixtureStores(), sse: new SseHub() };
}

describe('GET /api/dashboard', () => {
  it('TC-2: matches the seeded state — both fixture campaigns active, zero progress, no rewards', async () => {
    const state: AppState = buildState();
    const response = await request(createApp(state)).get('/api/dashboard?customerId=priya-shah');

    expect(response.status).toBe(200);
    expect(response.body.data.customerId).toBe('priya-shah');
    expect(response.body.data.activeCampaigns).toHaveLength(2);
    expect(
      response.body.data.activeCampaigns.map((c: { campaignId: number }) => c.campaignId).sort(),
    ).toEqual([FIXTURE_ALL_CAMPAIGN_ID, FIXTURE_NOF_CAMPAIGN_ID].sort());
    expect(response.body.data.trackerProgress).toHaveLength(2);
    expect(
      response.body.data.trackerProgress.every(
        (t: { completed: boolean }) => t.completed === false,
      ),
    ).toBe(true);
    expect(response.body.data.rewardCounts).toEqual({ total: 0, unused: 0, used: 0 });
    expect(response.body.data.expiringSoon).toEqual([]);
  });

  it('surfaces an unused reward expiring within the window, sorted soonest-first', async () => {
    const state: AppState = buildState();
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const laterReward: RewardLedgerEntry = {
      id: 'r-later',
      customerId: 'priya-shah',
      campaignId: FIXTURE_ALL_CAMPAIGN_ID,
      campaignCode: 'FIXTURE_ALL',
      type: 'promo_code',
      value: 'SAVE20',
      currency: null,
      status: 'unused',
      issuedAt: new Date().toISOString(),
      expiresAt: later,
    };
    const soonReward: RewardLedgerEntry = { ...laterReward, id: 'r-soon', expiresAt: soon };
    const farReward: RewardLedgerEntry = {
      ...laterReward,
      id: 'r-far',
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    };
    state.rewards.addReward(laterReward);
    state.rewards.addReward(soonReward);
    state.rewards.addReward(farReward);

    const response = await request(createApp(state)).get('/api/dashboard?customerId=priya-shah');

    expect(response.body.data.expiringSoon.map((r: { id: string }) => r.id)).toEqual([
      'r-soon',
      'r-later',
    ]);
    expect(response.body.data.rewardCounts).toEqual({ total: 3, unused: 3, used: 0 });
  });

  it('4xx for an unknown customerId (TC-11-equivalent for this route)', async () => {
    const response = await request(createApp(buildState())).get('/api/dashboard?customerId=nobody');
    expect(response.status).toBe(404);
  });
});
