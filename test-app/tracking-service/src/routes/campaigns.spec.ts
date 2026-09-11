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
import {
  RapProgressRequestError,
  RapProgressUnreachableError,
  type GetCampaignProgressParams,
  type GetTrackerProgressParams,
  type RapCampaignProgress,
  type RapProgressReader,
} from '../rap-progress-client';
import { SseHub, type AppState } from './index';

interface BuildStateOverrides {
  readonly portal?: PortalDataSource;
  readonly rapProgress?: RapProgressReader | null;
}

function buildState(overrides: BuildStateOverrides = {}): AppState {
  const stores = buildFixtureStores();
  return {
    customers: CUSTOMERS,
    ...stores,
    ...(overrides.portal ? { portal: overrides.portal } : {}),
    ...(overrides.rapProgress !== undefined ? { rapProgress: overrides.rapProgress } : {}),
    sse: new SseHub(),
  };
}

/** A {@link RapProgressReader} whose `getCampaignProgress` is fully controlled by the test — same
 * shape `routes/dashboard.spec.ts` (T-INT-021) already uses for the identical need. */
function fakeRapProgressReader(
  impl: (params: GetCampaignProgressParams) => Promise<RapCampaignProgress>,
): RapProgressReader {
  return {
    getCampaignProgress: impl,
    getTrackerProgress: (_params: GetTrackerProgressParams): Promise<never> => {
      throw new Error('fakeRapProgressReader: getTrackerProgress is not exercised by campaigns.ts');
    },
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
    // Structural fields always merge from `ProgressStore`, regardless of RAP; fixtures' own
    // default `rapProgress` is `null` ("unconfigured"), so completion state genuinely cannot be
    // determined yet — reported as unknown, never a fake `0` (T-INT-055, mirroring T-INT-021's own
    // contract). See the dedicated "RAP-sourced tracker progress" describe block below for the
    // real-progress/unreachable/completed cases.
    expect(allCampaign.progress.trackers).toEqual([
      expect.objectContaining({
        trackerCode: 'ALL_TRACKER',
        completionLogic: 'all',
        threshold: 2,
        completedCount: null,
        completed: null,
        progressUnknown: true,
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
              activityCode: 'NEW_ACTIVITY',
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
        portal: {
          getCampaigns: async () => [...FIXTURE_CAMPAIGNS, NEW_CAMPAIGN],
          getCampaignJourney: async (id: number) =>
            id === NEW_CAMPAIGN_ID ? NEW_JOURNEY : originalPortal.getCampaignJourney(id),
        },
        // RAP reached, but this brand-new campaign has no materialized progress on it yet — a
        // real, legitimate zero (RAP's own contract), never "unknown".
        rapProgress: fakeRapProgressReader(async (params) => ({
          customerId: params.customerId,
          campaignCode: params.campaignCode,
          trackers: [],
        })),
      });

      const response = await request(createApp(state)).get('/api/campaigns?customerId=priya-shah');

      const launched = response.body.data.find(
        (c: { campaignCode: string }) => c.campaignCode === 'BRAND_NEW_LAUNCH',
      );
      expect(launched).toBeDefined();
      expect(launched.progress.trackers[0]).toEqual(
        expect.objectContaining({
          trackerCode: 'NEW_TRACKER',
          completedCount: 0,
          completed: false,
          progressUnknown: false,
        }),
      );
    });

    it('a campaign no longer active stops appearing, even with existing progress on it', async () => {
      const originalPortal = new FakePortalDataSource();
      const state = buildState({
        portal: {
          getCampaigns: async () =>
            FIXTURE_CAMPAIGNS.map((c) =>
              c.campaignCode === 'FIXTURE_ALL' ? { ...c, status: 'paused' } : c,
            ),
          getCampaignJourney: (id: number) => originalPortal.getCampaignJourney(id),
        },
      });

      const response = await request(createApp(state)).get('/api/campaigns?customerId=priya-shah');

      expect(
        response.body.data.find((c: { campaignCode: string }) => c.campaignCode === 'FIXTURE_ALL'),
      ).toBeUndefined();
    });
  });

  describe('GET /api/campaigns — RAP-sourced tracker progress (T-INT-055, extending T-INT-021 to Campaign Detail)', () => {
    it('TC-1/TC-3: a real, partial RAP progress response is reflected verbatim, joined by trackerCode', async () => {
      const state = buildState({
        rapProgress: fakeRapProgressReader(async (params) => {
          if (params.campaignCode === 'FIXTURE_ALL') {
            return {
              customerId: params.customerId,
              campaignCode: params.campaignCode,
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
            };
          }
          return {
            customerId: params.customerId,
            campaignCode: params.campaignCode,
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
          };
        }),
      });

      const response = await request(createApp(state)).get('/api/campaigns?customerId=priya-shah');

      const allCampaign = response.body.data.find(
        (c: { campaignCode: string }) => c.campaignCode === 'FIXTURE_ALL',
      );
      const nofCampaign = response.body.data.find(
        (c: { campaignCode: string }) => c.campaignCode === 'FIXTURE_NOF',
      );
      expect(allCampaign.progress.trackers[0]).toMatchObject({
        completedCount: 1,
        threshold: 2,
        completed: false,
        progressUnknown: false,
      });
      // TC-3: threshold met → "completed" state, matching RAP's own `isCompleted` flag verbatim
      // (`n_of` threshold is 2, RAP reports 3 components completed — still just `completed: true`,
      // not a different shape).
      expect(nofCampaign.progress.trackers[0]).toMatchObject({
        completedCount: 3,
        threshold: 2,
        completed: true,
        progressUnknown: false,
      });
    });

    it('TC-2: RAP entirely unreachable degrades every tracker to progressUnknown, never a fake 0/5xx', async () => {
      const state = buildState({
        rapProgress: fakeRapProgressReader(async () => {
          throw new RapProgressUnreachableError(
            'REST',
            'http://rap.test',
            new Error('ECONNREFUSED'),
          );
        }),
      });

      const response = await request(createApp(state)).get('/api/campaigns?customerId=priya-shah');

      expect(response.status).toBe(200);
      const allCampaign = response.body.data.find(
        (c: { campaignCode: string }) => c.campaignCode === 'FIXTURE_ALL',
      );
      expect(allCampaign.progress.trackers[0]).toMatchObject({
        completedCount: null,
        completed: null,
        progressUnknown: true,
      });
    });

    it('a real rejected request (bad auth/config) also degrades to progressUnknown, never a 5xx', async () => {
      const state = buildState({
        rapProgress: fakeRapProgressReader(async () => {
          throw new RapProgressRequestError('REST', 401, 'invalid token');
        }),
      });

      const response = await request(createApp(state)).get('/api/campaigns?customerId=priya-shah');

      expect(response.status).toBe(200);
      expect(
        response.body.data.every(
          (c: { progress: { trackers: Array<{ progressUnknown: boolean }> } | null }) =>
            c.progress === null || c.progress.trackers.every((t) => t.progressUnknown === true),
        ),
      ).toBe(true);
    });

    it('no RAP fetch happens (and no crash) when no customerId is given', async () => {
      let called = false;
      const state = buildState({
        rapProgress: fakeRapProgressReader(async (params) => {
          called = true;
          return { customerId: params.customerId, campaignCode: params.campaignCode, trackers: [] };
        }),
      });

      const response = await request(createApp(state)).get('/api/campaigns');

      expect(response.status).toBe(200);
      expect(called).toBe(false);
      expect(response.body.data.every((c: { progress: null }) => c.progress === null)).toBe(true);
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
