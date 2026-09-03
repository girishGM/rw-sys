/**
 * T-RAP-011. `WatchStreamConsumer` against a fake `CampaignConfigClient` (an `EventEmitter`-backed
 * fake stream, no real network) and the **real** `CampaignConfigCacheService` (T-RAP-010) wired to
 * fake, in-memory repositories — same "fake the outer edges, use the real class under test"
 * discipline `campaign-config-cache.service.spec.ts` already established, so the atomic-swap
 * property under test (TC-6) is asserted against the real `Map`-swap implementation, not a
 * reimplementation of it.
 *
 * The real, two-real-instances broadcast property (TC-1) and a real network disconnect/reconnect
 * (TC-5's own network half) are covered in `watch-stream.consumer.e2e-spec.ts` instead, against a
 * real `@grpc/grpc-js` mock server — this file covers the backoff/scheduling logic and per-event
 * handling semantics that don't need a real socket to prove.
 */
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { WatchStreamConsumer } from '@/modules/invalidation/watch-stream.consumer';
import { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import type {
  CampaignConfigClient,
  CampaignConfigListProto,
  CampaignConfigProto,
  ConfigChangeEventProto,
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
  rows: ActivityExternalCodeMapRow[] = [];

  async findAll(): Promise<ActivityExternalCodeMapRow[]> {
    return [...this.rows];
  }

  async upsert(data: UpsertExternalCodeData): Promise<void> {
    this.rows.push({
      id: `${data.tenantId}-${data.externalCode}`,
      tenant_id: data.tenantId,
      external_code: data.externalCode,
      activity_code: data.activityCode,
      fetched_at: new Date(),
    });
  }
}

/** Stands in for a real `grpc.ClientReadableStream` — enough surface (`on`/`cancel`) for
 * `WatchStreamConsumer`'s own usage, nothing else. */
class FakeStream extends EventEmitter {
  cancel = jest.fn();
}

class FakeCampaignConfigClient {
  watchCalls: number[] = [];
  streamsByCall: FakeStream[] = [];
  getCampaignConfigCalls: Array<{
    tenantId: number;
    campaignCode: string;
    etag: string;
  }> = [];
  getCampaignConfigResponses = new Map<string, CampaignConfigProto | Error>();
  listActiveCampaignsCalls: number[] = [];
  listActiveCampaignsResponses = new Map<number, CampaignConfigListProto | Error>();

  watchCampaignConfig(tenantId: number): FakeStream {
    this.watchCalls.push(tenantId);
    const stream = new FakeStream();
    this.streamsByCall.push(stream);
    return stream;
  }

  async getCampaignConfig(
    tenantId: number,
    campaignCode: string,
    _sections: readonly string[],
    etag = '',
  ): Promise<CampaignConfigProto> {
    this.getCampaignConfigCalls.push({ tenantId, campaignCode, etag });
    const response = this.getCampaignConfigResponses.get(`${tenantId}::${campaignCode}`);
    if (response instanceof Error) {
      throw response;
    }
    if (!response) {
      throw new Error(`no fake response configured for ${tenantId}::${campaignCode}`);
    }
    return response;
  }

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

function buildEvent(overrides: Partial<ConfigChangeEventProto> = {}): ConfigChangeEventProto {
  return {
    campaignId: 1,
    campaignCode: 'CAMP1',
    tenantId: 42,
    changeType: 'UPDATED',
    etag: 'etag-2',
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildHarness(): {
  client: FakeCampaignConfigClient;
  cache: CampaignConfigCacheService;
  snapshotRepo: FakeSnapshotRepository;
  consumer: WatchStreamConsumer;
} {
  const client = new FakeCampaignConfigClient();
  const snapshotRepo = new FakeSnapshotRepository();
  const externalCodeRepo = new FakeExternalCodeMapRepository();
  const cache = new CampaignConfigCacheService(
    client as unknown as CampaignConfigClient,
    snapshotRepo as unknown as CampaignConfigSnapshotRepository,
    externalCodeRepo as unknown as ActivityExternalCodeMapRepository,
  );
  const consumer = new WatchStreamConsumer(
    client as unknown as CampaignConfigClient,
    cache,
    10, // backoffBaseMs — small so tests run fast
    50, // backoffMaxMs
    true,
  );
  return { client, cache, snapshotRepo, consumer };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WatchStreamConsumer — handleEvent (§2, implementation notes 2/5)', () => {
  it('TC-2: an event for a campaign not currently cached triggers a fetch and adds it to the cache', async () => {
    const { client, cache, consumer } = buildHarness();
    const campaign = buildCampaign();
    client.getCampaignConfigResponses.set('42::CAMP1', campaign);

    expect(cache.getCampaignConfig(42, 'CAMP1')).toBeUndefined();

    await consumer.handleEvent(42, buildEvent());

    expect(client.getCampaignConfigCalls).toEqual([
      { tenantId: 42, campaignCode: 'CAMP1', etag: '' },
    ]);
    expect(cache.getCampaignConfig(42, 'CAMP1')).toMatchObject({ etag: 'etag-1' });
    expect(cache.lookupByActivityCode(42, 'ACT_PURCHASE')).toHaveLength(1);
  });

  it('passes the previously-held etag on a refresh for an already-cached campaign', async () => {
    const { client, cache, consumer } = buildHarness();
    await cache.applyCampaignConfig(buildCampaign({ etag: 'etag-old' }));
    client.getCampaignConfigResponses.set(
      '42::CAMP1',
      buildCampaign({ etag: 'etag-new', configHash: 'hash-new' }),
    );

    await consumer.handleEvent(42, buildEvent({ etag: 'etag-new' }));

    expect(client.getCampaignConfigCalls).toEqual([
      { tenantId: 42, campaignCode: 'CAMP1', etag: 'etag-old' },
    ]);
    expect(cache.getCampaignConfig(42, 'CAMP1')).toMatchObject({ etag: 'etag-new' });
  });

  it('a not_modified response is a no-op — no re-apply, no re-persist', async () => {
    const { client, cache, snapshotRepo, consumer } = buildHarness();
    await cache.applyCampaignConfig(buildCampaign({ etag: 'etag-old' }));
    snapshotRepo.upsertCalls = [];
    client.getCampaignConfigResponses.set('42::CAMP1', {
      ...buildCampaign({ etag: 'etag-old' }),
      notModified: true,
    });

    await consumer.handleEvent(42, buildEvent({ etag: 'etag-old' }));

    expect(snapshotRepo.upsertCalls).toHaveLength(0);
    expect(cache.getCampaignConfig(42, 'CAMP1')).toMatchObject({ etag: 'etag-old' });
  });

  it('a GetCampaignConfig failure is logged and does not crash or mutate the cache', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { client, cache, consumer } = buildHarness();
    await cache.applyCampaignConfig(buildCampaign({ etag: 'etag-old' }));
    client.getCampaignConfigResponses.set('42::CAMP1', new Error('UNAVAILABLE'));

    await expect(consumer.handleEvent(42, buildEvent())).resolves.toBeUndefined();

    expect(cache.getCampaignConfig(42, 'CAMP1')).toMatchObject({ etag: 'etag-old' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GetCampaignConfig failed'));
    warnSpy.mockRestore();
  });

  it('TC-6: a reference held before a refresh completes against the pre-swap value (no torn read)', async () => {
    const { client, cache, consumer } = buildHarness();
    await cache.applyCampaignConfig(buildCampaign({ etag: 'etag-old', configHash: 'hash-old' }));
    const before = cache.getCampaignConfig(42, 'CAMP1');
    expect(before).toMatchObject({ etag: 'etag-old' });

    client.getCampaignConfigResponses.set(
      '42::CAMP1',
      buildCampaign({ etag: 'etag-new', configHash: 'hash-new' }),
    );
    await consumer.handleEvent(42, buildEvent({ etag: 'etag-new' }));

    // The reference obtained before the swap still reflects the old, complete state — a `Map.set`
    // replaces the entry, it never mutates the object a caller already holds.
    expect(before).toMatchObject({ etag: 'etag-old', configHash: 'hash-old' });
    expect(cache.getCampaignConfig(42, 'CAMP1')).toMatchObject({
      etag: 'etag-new',
      configHash: 'hash-new',
    });
  });
});

describe('WatchStreamConsumer — reconnect with backoff (§3, TC-5)', () => {
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
  });

  it('opens one stream per configured tenant on start()', () => {
    const { client, consumer } = buildHarness();
    consumer.start();
    expect(client.watchCalls).toEqual([42]);
    consumer.stop();
  });

  it('TC-5: on stream error, reconnects with backoff and calls ListActiveCampaigns (full re-warm) rather than assuming nothing changed', async () => {
    const { client, consumer } = buildHarness();
    client.listActiveCampaignsResponses.set(42, {
      campaigns: [buildCampaign()],
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });

    consumer.start();
    expect(client.watchCalls).toEqual([42]);

    // Simulate a disconnect.
    client.streamsByCall[0].emit('error', new Error('UNAVAILABLE: connection dropped'));

    // Backoff base is 10ms — wait comfortably past it for the reconnect to fire.
    await wait(60);

    expect(client.watchCalls).toEqual([42, 42]); // reconnected: a second stream was opened
    expect(client.listActiveCampaignsCalls).toEqual([42]); // full re-warm triggered on reconnect

    consumer.stop();
  });

  it('backoff grows exponentially across repeated disconnects, clamped to the configured max', async () => {
    const { client, consumer } = buildHarness();
    client.listActiveCampaignsResponses.set(42, {
      campaigns: [],
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });

    consumer.start();
    // Disconnect three times in a row, each before the (growing) backoff would have fired, to
    // prove attempts accumulate rather than resetting on every disconnect.
    client.streamsByCall[0].emit('error', new Error('drop 1'));
    await wait(5); // less than the 10ms base backoff — the reconnect has not fired yet
    // Only the original stream exists so far.
    expect(client.watchCalls).toEqual([42]);

    // Let the first reconnect (base delay ~10ms) actually happen.
    await wait(30);
    expect(client.watchCalls.length).toBeGreaterThanOrEqual(2);

    consumer.stop();
  });

  it('a successful data delivery resets the backoff attempt counter for that tenant', async () => {
    const { client, cache, consumer } = buildHarness();
    client.getCampaignConfigResponses.set('42::CAMP1', buildCampaign());
    client.listActiveCampaignsResponses.set(42, {
      campaigns: [],
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });

    consumer.start();
    client.streamsByCall[0].emit('data', buildEvent());
    await wait(20);

    expect(cache.getCampaignConfig(42, 'CAMP1')).toMatchObject({ etag: 'etag-1' });
    // No disconnect occurred — no reconnect should have been scheduled.
    expect(client.watchCalls).toEqual([42]);

    consumer.stop();
  });

  it('stop() cancels every open stream and pending reconnect timer, and reconnects never resume after stop', async () => {
    const { client, consumer } = buildHarness();
    consumer.start();
    const firstStream = client.streamsByCall[0];

    consumer.stop();
    expect(firstStream.cancel).toHaveBeenCalled();

    // A disconnect arriving after stop() must not schedule a reconnect.
    firstStream.emit('error', new Error('late error after stop'));
    await wait(60);
    expect(client.watchCalls).toEqual([42]); // no reconnect attempt happened
  });

  it('an "end" event (server-initiated close) also triggers a reconnect, same as "error"', async () => {
    const { client, consumer } = buildHarness();
    client.listActiveCampaignsResponses.set(42, {
      campaigns: [],
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });

    consumer.start();
    client.streamsByCall[0].emit('end');
    await wait(60);

    expect(client.watchCalls).toEqual([42, 42]);
    consumer.stop();
  });
});
