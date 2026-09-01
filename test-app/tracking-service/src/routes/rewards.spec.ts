import request from 'supertest';
import { createApp } from '../app';
import { CUSTOMERS } from '../data/customers';
import type { RewardLedgerEntry } from '../data/rewards';
import { buildFixtureStores } from '../test-support/fixtures';
import { SseHub, type AppState } from './index';

const SEEDED_REWARD: RewardLedgerEntry = {
  id: 'seed-1',
  customerId: 'priya-shah',
  campaignId: 1001,
  campaignCode: 'FIXTURE_ALL',
  type: 'promo_code',
  value: 'SAVE20',
  currency: null,
  status: 'unused',
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-12-31',
};

function buildState(): AppState {
  const stores = buildFixtureStores();
  stores.rewards.addReward(SEEDED_REWARD);
  return { customers: CUSTOMERS, ...stores, sse: new SseHub() };
}

describe('GET /api/rewards', () => {
  it('TC-4: returns the seeded reward ledger for a known customer', async () => {
    const response = await request(createApp(buildState())).get(
      '/api/rewards?customerId=priya-shah',
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([SEEDED_REWARD]);
  });

  it('returns [] for a customer with no rewards yet (not an error)', async () => {
    const response = await request(createApp(buildState())).get(
      '/api/rewards?customerId=marcus-tan',
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it('4xx for a missing customerId', async () => {
    const response = await request(createApp(buildState())).get('/api/rewards');
    expect(response.status).toBe(400);
  });

  it('4xx for an unknown customerId', async () => {
    const response = await request(createApp(buildState())).get('/api/rewards?customerId=nobody');
    expect(response.status).toBe(404);
  });
});
