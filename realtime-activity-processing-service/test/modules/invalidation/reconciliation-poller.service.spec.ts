/**
 * T-RAP-011. `ReconciliationPollerService` against a fake `CampaignConfigClient` and the real
 * `CampaignConfigCacheService` (T-RAP-010) wired to fake, in-memory repositories — same "fake the
 * outer edges" discipline `watch-stream.consumer.spec.ts` uses. No network, no real DB; the poller
 * needs no real stream to exercise (`ReconciliationPollerService` never touches
 * `WatchCampaignConfig` at all).
 */
import { Logger } from '@nestjs/common';
import { ReconciliationPollerService } from '@/modules/invalidation/reconciliation-poller.service';
import { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import type {
  CampaignConfigClient,
  CampaignConfigListProto,
  CampaignConfigProto,
} from '@/modules/campaign-cache/campaign-config.client';
import type {
  ActivityExternalCodeMapRepository,
  CampaignConfigSnapshotRepository,
  UpsertExternalCodeData,
  UpsertSnapshotData,
} from '@/modules/campaign-cache/campaign-config-snapshot.repository';
import type { CampaignConfigSnapshotRow } from '@/database/models/campaign-config-snapshot.model';
import type { ActivityExternalCodeMapRow } from '@/database/models/activity-external-code-map.model';

class FakeSnapshotRepository {
  rows: CampaignConfigSnapshotRow[] = [];
  upsertCalls: UpsertSnapshotData[] = [];

  async findAll(): Promise<CampaignConfigSnapshotRow[]> {
    return [...this.rows];
  }

  async upsert(data: UpsertSnapshotData): Promise<void> {
    this.upsertCalls.push(data);
    const row: CampaignConfigSnapshotRow = {
      id: `${data.tenantId}-${data.campaignCode}`,
      tenant_id: data.tenantId,
      campaign_code: data.campaignCode,
      config_version: data.configVersion,
      is_active: data.isActive,
      payload: data.payload,
      fetched_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };
    const idx = this.rows.findIndex(
      (r) => r.tenant_id === data.tenantId && r.campaign_code === data.campaignCode,
    );
    if (idx >= 0) {
      this.rows[idx] = row;
    } else {
      this.rows.push(row);
    }
  }
}

class FakeExternalCodeMapRepository {
  async findAll(): Promise<ActivityExternalCodeMapRow[]> {
    return [];
  }

  async upsert(_data: UpsertExternalCodeData): Promise<void> {
    // no-op — no test below exercises external codes
  }
}

class FakeCampaignConfigClient {
  listActiveCampaignsCalls: number[] = [];
  listActiveCampaignsResponses = new Map<number, CampaignConfigListProto | Error>();

  async listActiveCampaigns(tenantId: number): Promise<CampaignConfigListProto> {
    this.listActiveCampaignsCalls.push(tenantId);
    const response = this.listActiveCampaignsResponses.get(tenantId);
    if (response instanceof Error) {
      throw response;
    }
    return (
      response ?? {
        campaigns: [],
        servedAt: new Date().toISOString(),
        sectionsReturned: [],
        sectionsOmitted: [],
      }
    );
  }
}

function buildCampaign(overrides: Partial<CampaignConfigProto> = {}): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode: 'CAMP1',
    tenantId: 42,
    countryId: 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    budget: { amount: '1000.00', currency: 'USD' },
    maxParticipants: 100,
    merchants: [
      {
        merchantId: 1,
        merchantCode: 'MERCH1',
        name: 'Merchant One',
        status: 'active',
        activities: [
          { activityId: 10, activityCode: 'ACT_PURCHASE', name: 'Purchase', externalCodes: [] },
        ],
      },
    ],
    trackers: [
      {
        trackerId: 100,
        trackerCode: 'TRK1',
        name: 'Tracker One',
        completionLogic: 'all',
        completionThreshold: 1,
        status: 'active',
        components: [
          {
            componentId: 1000,
            componentCode: 'COMP1',
            name: 'Component One',
            activityId: 10,
            sequenceOrder: 1,
            isMandatory: true,
            status: 'active',
          },
        ],
      },
    ],
    rules: [],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS'],
    sectionsOmitted: [],
    ...overrides,
  };
}

function buildHarness(): {
  client: FakeCampaignConfigClient;
  cache: CampaignConfigCacheService;
  snapshotRepo: FakeSnapshotRepository;
  poller: ReconciliationPollerService;
} {
  const client = new FakeCampaignConfigClient();
  const snapshotRepo = new FakeSnapshotRepository();
  const externalCodeRepo = new FakeExternalCodeMapRepository();
  const cache = new CampaignConfigCacheService(
    client as unknown as CampaignConfigClient,
    snapshotRepo as unknown as CampaignConfigSnapshotRepository,
    externalCodeRepo as unknown as ActivityExternalCodeMapRepository,
  );
  const poller = new ReconciliationPollerService(
    client as unknown as CampaignConfigClient,
    cache,
    60_000, // pollIntervalMs — irrelevant to runOnce()-driven tests below
    false, // autostart — tests drive runOnce() directly, never a live setInterval
  );
  return { client, cache, snapshotRepo, poller };
}

describe('ReconciliationPollerService — runOnce (§3, implementation note 4)', () => {
  const originalTenantIds = process.env.PORTAL_CONFIG_TENANT_IDS;

  beforeEach(() => {
    process.env.PORTAL_CONFIG_TENANT_IDS = '42';
  });

  afterEach(() => {
    if (originalTenantIds === undefined) {
      delete process.env.PORTAL_CONFIG_TENANT_IDS;
    } else {
      process.env.PORTAL_CONFIG_TENANT_IDS = originalTenantIds;
    }
    jest.restoreAllMocks();
  });

  it('TC-3: no etag drift — no re-apply, a no-op is logged', async () => {
    const { client, cache, snapshotRepo, poller } = buildHarness();
    await cache.applyCampaignConfig(buildCampaign({ etag: 'etag-1' }));
    snapshotRepo.upsertCalls = [];
    client.listActiveCampaignsResponses.set(42, {
      campaigns: [buildCampaign({ etag: 'etag-1' })], // identical etag — no drift
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await poller.runOnce();

    expect(client.listActiveCampaignsCalls).toEqual([42]);
    expect(snapshotRepo.upsertCalls).toHaveLength(0); // no refetch/re-apply triggered
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no etag drift, no-op'));
  });

  it('TC-4: exactly the campaign whose etag differs is refreshed, the rest are left untouched', async () => {
    const { client, cache, snapshotRepo, poller } = buildHarness();
    await cache.applyCampaignConfig(buildCampaign({ campaignCode: 'CAMP1', etag: 'etag-1' }));
    await cache.applyCampaignConfig(
      buildCampaign({
        campaignCode: 'CAMP2',
        etag: 'etag-2',
        merchants: [
          {
            merchantId: 2,
            merchantCode: 'MERCH2',
            name: 'Merchant Two',
            status: 'active',
            activities: [
              { activityId: 20, activityCode: 'ACT_OTHER', name: 'Other', externalCodes: [] },
            ],
          },
        ],
        trackers: [],
      }),
    );
    snapshotRepo.upsertCalls = [];

    // CAMP1's etag drifted (a missed ConfigChangeEvent); CAMP2's did not.
    client.listActiveCampaignsResponses.set(42, {
      campaigns: [
        buildCampaign({ campaignCode: 'CAMP1', etag: 'etag-1-new', configHash: 'hash-new' }),
        buildCampaign({
          campaignCode: 'CAMP2',
          etag: 'etag-2',
          merchants: [
            {
              merchantId: 2,
              merchantCode: 'MERCH2',
              name: 'Merchant Two',
              status: 'active',
              activities: [
                { activityId: 20, activityCode: 'ACT_OTHER', name: 'Other', externalCodes: [] },
              ],
            },
          ],
          trackers: [],
        }),
      ],
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });

    await poller.runOnce();

    expect(snapshotRepo.upsertCalls.map((c) => c.campaignCode)).toEqual(['CAMP1']);
    expect(cache.getCampaignConfig(42, 'CAMP1')).toMatchObject({ etag: 'etag-1-new' });
    expect(cache.getCampaignConfig(42, 'CAMP2')).toMatchObject({ etag: 'etag-2' });
  });

  it('a ListActiveCampaigns failure for one tenant is logged and does not throw', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { client, poller } = buildHarness();
    client.listActiveCampaignsResponses.set(42, new Error('UNAVAILABLE'));

    await expect(poller.runOnce()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Reconciliation ListActiveCampaigns failed'),
    );
    warnSpy.mockRestore();
  });

  it('a slow cycle in flight is not duplicated by an overlapping runOnce() call', async () => {
    const { client, poller } = buildHarness();
    let resolveListActiveCampaigns: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveListActiveCampaigns = resolve;
    });
    const originalList = client.listActiveCampaigns.bind(client);
    client.listActiveCampaigns = async (tenantId: number) => {
      await gate;
      return originalList(tenantId);
    };

    const first = poller.runOnce();
    const second = poller.runOnce();

    resolveListActiveCampaigns?.();
    await Promise.all([first, second]);

    // Both calls resolve, but only one underlying fetch actually happened — the second call
    // joined the already-in-flight cycle rather than starting a concurrent second one.
    expect(client.listActiveCampaignsCalls).toEqual([42]);
  });

  it('startup behaviour (implementation note 4): onModuleInit runs one poll immediately', async () => {
    const { client, poller } = buildHarness();
    client.listActiveCampaignsResponses.set(42, {
      campaigns: [],
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });

    poller.onModuleInit();
    await Promise.resolve(); // let the fire-and-forget runOnce() promise chain settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(client.listActiveCampaignsCalls).toEqual([42]);
    poller.onModuleDestroy();
  });
});
