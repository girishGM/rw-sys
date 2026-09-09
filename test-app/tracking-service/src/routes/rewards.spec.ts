import request from 'supertest';
import { createApp } from '../app';
import { CUSTOMERS } from '../data/customers';
import type { RewardLedgerEntry } from '../data/rewards';
import type { PortalDataSource } from '../engine';
import {
  RewardTrackingRequestError,
  RewardTrackingTransportNotAvailableError,
  RewardTrackingUnreachableError,
  type CustomerRewardsSummary,
  type RewardTrackingClient,
} from '../reward-tracking-client';
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

interface BuildStateOverrides {
  readonly portal?: PortalDataSource;
  readonly rewardTracking?: RewardTrackingClient | null;
}

function buildState(overrides: BuildStateOverrides = {}): AppState {
  const stores = buildFixtureStores();
  stores.rewards.addReward(SEEDED_REWARD);
  return {
    customers: CUSTOMERS,
    ...stores,
    ...(overrides.portal ? { portal: overrides.portal } : {}),
    ...(overrides.rewardTracking !== undefined ? { rewardTracking: overrides.rewardTracking } : {}),
    sse: new SseHub(),
  };
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

/** A campaign source reporting zero campaigns — the "no tenant context yet" edge case
 * `resolveTenantId` (routes/rewards.ts) treats as `unavailable`, never a guessed tenant id. */
class EmptyPortalDataSource implements PortalDataSource {
  async getCampaigns() {
    return [];
  }
  async getCampaignJourney(): Promise<never> {
    throw new Error('EmptyPortalDataSource has no journeys');
  }
}

function fakeRewardTrackingClient(
  impl: (params: {
    customerId: string;
    tenantId: number;
    campaignCode?: string;
  }) => Promise<CustomerRewardsSummary>,
): RewardTrackingClient {
  return { getCustomerRewardsSummary: impl };
}

describe('GET /api/rewards/confirmed (T-INT-022 — RTS leg 7, TC-1/TC-2/TC-4/TC-5)', () => {
  it("reports status 'not_configured' when no reward-tracking client is wired (CUSTOMER_API_AUTH_SECRET unset)", async () => {
    // fixtures' own rewardTracking default is null, per createRewardTrackingClientFromEnv's
    // "unconfigured" contract — no override needed to exercise this path.
    const response = await request(createApp(buildState())).get(
      '/api/rewards/confirmed?customerId=priya-shah',
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ status: 'not_configured' });
  });

  it('TC-1: status ok, real summary data passed through verbatim, scoped by the resolved tenantId', async () => {
    const summary: CustomerRewardsSummary = {
      customerId: 'priya-shah',
      components: [
        {
          trackerCode: 'ALL_TRACKER',
          componentCode: 'COMP_A',
          rewardCategory: 'TRACKER',
          rewardKind: 'FIXED_AMOUNT',
          unitType: 'currency',
          unitCode: 'USD',
          totalValue: '25.0000',
          totalCount: 1,
        },
      ],
    };
    let receivedTenantId: number | undefined;
    const state = buildState({
      rewardTracking: fakeRewardTrackingClient(async (params) => {
        receivedTenantId = params.tenantId;
        return summary;
      }),
    });

    const response = await request(createApp(state)).get(
      '/api/rewards/confirmed?customerId=priya-shah',
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ status: 'ok', ...summary });
    expect(receivedTenantId).toBe(1); // FIXTURE_CAMPAIGNS[0].tenantId, test-support/fixtures.ts
  });

  it('TC-2 (negative): RTS unreachable degrades to status unavailable, never a 5xx/crash', async () => {
    const state = buildState({
      rewardTracking: fakeRewardTrackingClient(async () => {
        throw new RewardTrackingUnreachableError('http://rts.test', new Error('ECONNREFUSED'));
      }),
    });

    const response = await request(createApp(state)).get(
      '/api/rewards/confirmed?customerId=priya-shah',
    );

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('unavailable');
    expect(typeof response.body.data.message).toBe('string');
  });

  it('a real HTTP error from RTS also degrades to status unavailable', async () => {
    const state = buildState({
      rewardTracking: fakeRewardTrackingClient(async () => {
        throw new RewardTrackingRequestError(401, 'bad token');
      }),
    });

    const response = await request(createApp(state)).get(
      '/api/rewards/confirmed?customerId=priya-shah',
    );

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('unavailable');
  });

  it('TC-4: GRPC-selected-but-unavailable degrades to status unavailable with a clear message, not a hang', async () => {
    const state = buildState({
      rewardTracking: fakeRewardTrackingClient(async () => {
        throw new RewardTrackingTransportNotAvailableError('GRPC');
      }),
    });

    const response = await request(createApp(state)).get(
      '/api/rewards/confirmed?customerId=priya-shah',
    );

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('unavailable');
    expect(response.body.data.message).toMatch(/GRPC is not available/);
  });

  it('reports status unavailable when the portal has no campaigns yet (no tenant context to scope by)', async () => {
    const state = buildState({
      portal: new EmptyPortalDataSource(),
      rewardTracking: fakeRewardTrackingClient(async () => {
        throw new Error('should never be called — tenantId could not be resolved');
      }),
    });

    const response = await request(createApp(state)).get(
      '/api/rewards/confirmed?customerId=priya-shah',
    );

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('unavailable');
  });

  it('4xx for a missing customerId', async () => {
    const response = await request(createApp(buildState())).get('/api/rewards/confirmed');
    expect(response.status).toBe(400);
  });

  it('4xx for an unknown customerId', async () => {
    const response = await request(createApp(buildState())).get(
      '/api/rewards/confirmed?customerId=nobody',
    );
    expect(response.status).toBe(404);
  });
});
