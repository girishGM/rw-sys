import request from 'supertest';
import { createApp } from '../app';
import { CUSTOMERS } from '../data/customers';
import type { RewardLedgerEntry } from '../data/rewards';
import {
  RapProgressRequestError,
  RapProgressTransportNotAvailableError,
  RapProgressUnavailableError,
  RapProgressUnreachableError,
  type GetCampaignProgressParams,
  type GetTrackerProgressParams,
  type RapCampaignProgress,
  type RapProgressReader,
} from '../rap-progress-client';
import {
  buildFixtureStores,
  FIXTURE_ALL_CAMPAIGN_ID,
  FIXTURE_NOF_CAMPAIGN_ID,
} from '../test-support/fixtures';
import { SseHub, type AppState } from './index';

interface BuildStateOverrides {
  readonly rapProgress?: RapProgressReader | null;
}

function buildState(overrides: BuildStateOverrides = {}): AppState {
  return {
    customers: CUSTOMERS,
    ...buildFixtureStores(),
    ...(overrides.rapProgress !== undefined ? { rapProgress: overrides.rapProgress } : {}),
    sse: new SseHub(),
  };
}

/** A {@link RapProgressReader} whose `getCampaignProgress` is fully controlled by the test;
 * `getTrackerProgress` is never exercised by `routes/dashboard.ts` (it only ever calls the
 * per-campaign RPC, one call per campaign — see that file's own header), so it throws if reached. */
function fakeRapProgressReader(
  impl: (params: GetCampaignProgressParams) => Promise<RapCampaignProgress>,
): RapProgressReader {
  return {
    getCampaignProgress: impl,
    getTrackerProgress: (_params: GetTrackerProgressParams): Promise<never> => {
      throw new Error('fakeRapProgressReader: getTrackerProgress is not exercised by dashboard.ts');
    },
  };
}

describe('GET /api/dashboard', () => {
  it('TC-2: matches the seeded state — both fixture campaigns active, no rewards, RAP progress unknown (not configured)', async () => {
    // fixtures' own `rapProgress` default is `null`, per `createRapProgressClientFromEnv`'s
    // "unconfigured" contract — no override needed to exercise this path (T-INT-021).
    const state: AppState = buildState();
    const response = await request(createApp(state)).get('/api/dashboard?customerId=priya-shah');

    expect(response.status).toBe(200);
    expect(response.body.data.customerId).toBe('priya-shah');
    expect(response.body.data.activeCampaigns).toHaveLength(2);
    expect(
      response.body.data.activeCampaigns.map((c: { campaignId: number }) => c.campaignId).sort(),
    ).toEqual([FIXTURE_ALL_CAMPAIGN_ID, FIXTURE_NOF_CAMPAIGN_ID].sort());
    expect(response.body.data.trackerProgress).toHaveLength(2);
    // No `rapProgress` client wired — every tracker's completion state genuinely cannot be
    // determined, so it must be reported as unknown, never as an invented zero (this task's own
    // Implementation note 4).
    expect(
      response.body.data.trackerProgress.every(
        (t: {
          completed: boolean | null;
          completedCount: number | null;
          progressUnknown: boolean;
        }) => t.completed === null && t.completedCount === null && t.progressUnknown === true,
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

describe('GET /api/dashboard — RAP-sourced tracker progress (T-INT-021, leg 2/finding 4)', () => {
  it('TC-1/TC-4: a real, partial RAP progress response is reflected verbatim, joined by campaignCode/trackerCode', async () => {
    const rapProgress: Record<string, RapCampaignProgress> = {
      FIXTURE_ALL: {
        customerId: 'priya-shah',
        campaignCode: 'FIXTURE_ALL',
        trackers: [
          {
            trackerCode: 'ALL_TRACKER',
            completionLogic: 'all',
            isCompleted: false,
            completedAt: null,
            componentsRequiredCount: 2,
            componentsCompletedCount: 1,
            components: [],
          },
        ],
      },
      FIXTURE_NOF: {
        customerId: 'priya-shah',
        campaignCode: 'FIXTURE_NOF',
        trackers: [
          {
            trackerCode: 'NOF_TRACKER',
            completionLogic: 'n_of',
            isCompleted: true,
            completedAt: '2026-02-01T00:00:00.000Z',
            componentsRequiredCount: 2,
            componentsCompletedCount: 3,
            components: [],
          },
        ],
      },
    };
    const state = buildState({
      rapProgress: fakeRapProgressReader(async (params) => {
        const found = rapProgress[params.campaignCode];
        if (!found) throw new Error(`unexpected campaignCode ${params.campaignCode}`);
        return found;
      }),
    });

    const response = await request(createApp(state)).get('/api/dashboard?customerId=priya-shah');

    expect(response.status).toBe(200);
    const byTracker = new Map(
      response.body.data.trackerProgress.map((t: { trackerCode: string }) => [t.trackerCode, t]),
    );
    expect(byTracker.get('ALL_TRACKER')).toMatchObject({
      completedCount: 1,
      threshold: 2,
      completed: false,
      progressUnknown: false,
    });
    expect(byTracker.get('NOF_TRACKER')).toMatchObject({
      completedCount: 3,
      threshold: 2,
      completed: true,
      progressUnknown: false,
    });
  });

  it('a tracker with no materialized RAP progress yet is a real, legitimate zero — never unknown', async () => {
    const state = buildState({
      rapProgress: fakeRapProgressReader(async (params) => ({
        customerId: 'priya-shah',
        campaignCode: params.campaignCode,
        trackers: [], // RAP's own contract: "Empty trackers is a normal response".
      })),
    });

    const response = await request(createApp(state)).get('/api/dashboard?customerId=priya-shah');

    expect(response.status).toBe(200);
    expect(
      response.body.data.trackerProgress.every(
        (t: { completedCount: number; completed: boolean; progressUnknown: boolean }) =>
          t.completedCount === 0 && t.completed === false && t.progressUnknown === false,
      ),
    ).toBe(true);
  });

  it('TC-3 (negative): RAP entirely unreachable degrades to progressUnknown, never a 5xx/crash', async () => {
    const state = buildState({
      rapProgress: fakeRapProgressReader(async () => {
        throw new RapProgressUnreachableError('REST', 'http://rap.test', new Error('ECONNREFUSED'));
      }),
    });

    const response = await request(createApp(state)).get('/api/dashboard?customerId=priya-shah');

    expect(response.status).toBe(200);
    expect(
      response.body.data.trackerProgress.every(
        (t: { completed: boolean | null; progressUnknown: boolean }) =>
          t.completed === null && t.progressUnknown === true,
      ),
    ).toBe(true);
  });

  it('both transports failing (RapProgressUnavailableError) also degrades to progressUnknown', async () => {
    const state = buildState({
      rapProgress: fakeRapProgressReader(async () => {
        throw new RapProgressUnavailableError(new Error('rest down'), new Error('grpc down'));
      }),
    });

    const response = await request(createApp(state)).get('/api/dashboard?customerId=priya-shah');

    expect(response.status).toBe(200);
    expect(
      response.body.data.trackerProgress.every(
        (t: { progressUnknown: boolean }) => t.progressUnknown === true,
      ),
    ).toBe(true);
  });

  it('TC-5-equivalent: GRPC selected but not available for this leg degrades to progressUnknown, not a hang', async () => {
    const state = buildState({
      rapProgress: fakeRapProgressReader(async () => {
        throw new RapProgressTransportNotAvailableError('GRPC', 'invalid TLS configuration');
      }),
    });

    const response = await request(createApp(state)).get('/api/dashboard?customerId=priya-shah');

    expect(response.status).toBe(200);
    expect(
      response.body.data.trackerProgress.every(
        (t: { progressUnknown: boolean }) => t.progressUnknown === true,
      ),
    ).toBe(true);
  });

  it('a real rejected request (bad auth/config) also degrades to progressUnknown, never a 5xx', async () => {
    const state = buildState({
      rapProgress: fakeRapProgressReader(async () => {
        throw new RapProgressRequestError('REST', 401, 'invalid token');
      }),
    });

    const response = await request(createApp(state)).get('/api/dashboard?customerId=priya-shah');

    expect(response.status).toBe(200);
    expect(
      response.body.data.trackerProgress.every(
        (t: { progressUnknown: boolean }) => t.progressUnknown === true,
      ),
    ).toBe(true);
  });
});
