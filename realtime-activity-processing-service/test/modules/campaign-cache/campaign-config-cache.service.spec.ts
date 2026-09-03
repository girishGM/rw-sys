/**
 * T-RAP-010. Unit tests for `CampaignConfigCacheService` against fake, in-memory stand-ins for
 * `CampaignConfigClient`/`CampaignConfigSnapshotRepository`/`ActivityExternalCodeMapRepository` —
 * no network, no real DB. TC-1/TC-2/TC-3 (real cold-start behaviour against a real mock portal and
 * real Postgres) are exercised in `campaign-config-cache.e2e-spec.ts` instead; this file covers
 * TC-4/TC-5/TC-6 (the matching semantics) plus the indexing/vanish logic those cases depend on.
 *
 * Fakes are cast `as unknown as <RealClass>` rather than typed as an interface: every real class
 * here has a `private`/constructor-property field, which makes TypeScript treat it as nominally
 * (not structurally) typed — a plain object with matching public methods is not assignable to it
 * without the cast. Standard, narrow test-only escape hatch; not `any` anywhere (R9).
 */
import { Logger } from '@nestjs/common';
import {
  CampaignConfigCacheService,
  resolveConfiguredTenantIds,
} from '@/modules/campaign-cache/campaign-config-cache.service';
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

  async findAll(): Promise<CampaignConfigSnapshotRow[]> {
    return [...this.rows];
  }

  async upsert(data: UpsertSnapshotData): Promise<void> {
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
    const row: ActivityExternalCodeMapRow = {
      id: `${data.tenantId}-${data.externalCode}`,
      tenant_id: data.tenantId,
      external_code: data.externalCode,
      activity_code: data.activityCode,
      fetched_at: new Date(),
    };
    const idx = this.rows.findIndex(
      (r) => r.tenant_id === data.tenantId && r.external_code === data.externalCode,
    );
    if (idx >= 0) {
      this.rows[idx] = row;
    } else {
      this.rows.push(row);
    }
  }
}

class FakeCampaignConfigClient {
  responses = new Map<number, CampaignConfigListProto | Error>();

  async listActiveCampaigns(tenantId: number): Promise<CampaignConfigListProto> {
    const response = this.responses.get(tenantId);
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
          {
            activityId: 10,
            activityCode: 'ACT_PURCHASE',
            name: 'Purchase',
            externalCodes: ['TXN_PURCHASE'],
          },
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

function buildService(): {
  service: CampaignConfigCacheService;
  client: FakeCampaignConfigClient;
  snapshotRepo: FakeSnapshotRepository;
  externalCodeRepo: FakeExternalCodeMapRepository;
} {
  const client = new FakeCampaignConfigClient();
  const snapshotRepo = new FakeSnapshotRepository();
  const externalCodeRepo = new FakeExternalCodeMapRepository();
  const service = new CampaignConfigCacheService(
    client as unknown as CampaignConfigClient,
    snapshotRepo as unknown as CampaignConfigSnapshotRepository,
    externalCodeRepo as unknown as ActivityExternalCodeMapRepository,
  );
  return { service, client, snapshotRepo, externalCodeRepo };
}

describe('resolveConfiguredTenantIds', () => {
  const originalValue = process.env.PORTAL_CONFIG_TENANT_IDS;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.PORTAL_CONFIG_TENANT_IDS;
    } else {
      process.env.PORTAL_CONFIG_TENANT_IDS = originalValue;
    }
  });

  it('throws when unset', () => {
    delete process.env.PORTAL_CONFIG_TENANT_IDS;
    expect(() => resolveConfiguredTenantIds()).toThrow(/PORTAL_CONFIG_TENANT_IDS is required/);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    process.env.PORTAL_CONFIG_TENANT_IDS = ' 1, 2 ,3';
    expect(resolveConfiguredTenantIds()).toEqual([1, 2, 3]);
  });

  it('rejects a non-integer entry', () => {
    process.env.PORTAL_CONFIG_TENANT_IDS = '1,abc';
    expect(() => resolveConfiguredTenantIds()).toThrow(/Invalid PORTAL_CONFIG_TENANT_IDS entry/);
  });
});

describe('CampaignConfigCacheService — matching (TC-4/TC-5/TC-6)', () => {
  it('TC-4: lookupByActivityCode returns the matched component for an active campaign/tracker/component', async () => {
    const { service } = buildService();
    const campaign = buildCampaign();
    await service.applyCampaignConfig(campaign);

    const matches = service.lookupByActivityCode(42, 'ACT_PURCHASE');
    expect(matches).toEqual([
      {
        tenantId: 42,
        campaignCode: 'CAMP1',
        campaignId: 1,
        trackerCode: 'TRK1',
        trackerId: 100,
        componentCode: 'COMP1',
        componentId: 1000,
        activityId: 10,
        activityCode: 'ACT_PURCHASE',
      },
    ]);
  });

  it('TC-5: lookupByActivityCode returns no match when the campaign is not active (paused)', async () => {
    const { service } = buildService();
    const campaign = buildCampaign({ status: 'paused' });
    await service.applyCampaignConfig(campaign);

    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toEqual([]);
    // Still resolvable for audit/history purposes, but flagged not-active (01-DATABASE.md §1).
    expect(service.getCampaignConfig(42, 'CAMP1')).toMatchObject({
      isActive: false,
      status: 'paused',
    });
  });

  it('a component whose own status is not active is not indexed, even in an active tracker/campaign', async () => {
    const { service } = buildService();
    const campaign = buildCampaign();
    campaign.trackers[0].components[0].status = 'paused';
    await service.applyCampaignConfig(campaign);

    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toEqual([]);
  });

  it('a tracker whose own status is not active is not indexed, even in an active campaign', async () => {
    const { service } = buildService();
    const campaign = buildCampaign();
    campaign.trackers[0].status = 'paused';
    await service.applyCampaignConfig(campaign);

    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toEqual([]);
  });

  it('TC-6: lookupByTransactionType resolves via activity_external_code_map, then matches as TC-4', async () => {
    const { service } = buildService();
    const campaign = buildCampaign();
    await service.applyCampaignConfig(campaign);

    expect(service.resolveExternalCode(42, 'TXN_PURCHASE')).toBe('ACT_PURCHASE');
    expect(service.lookupByTransactionType(42, 'TXN_PURCHASE')).toEqual(
      service.lookupByActivityCode(42, 'ACT_PURCHASE'),
    );
  });

  it('lookupByTransactionType returns [] (not an error) for an unmapped transactionType', () => {
    const { service } = buildService();
    expect(service.lookupByTransactionType(42, 'UNKNOWN_TXN')).toEqual([]);
  });

  it("a lookup result cannot be used to mutate this service's own internal state", async () => {
    const { service } = buildService();
    await service.applyCampaignConfig(buildCampaign());

    const matches = service.lookupByActivityCode(42, 'ACT_PURCHASE');
    matches.push({ ...matches[0], componentCode: 'INJECTED' });

    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toHaveLength(1);
  });
});

describe('CampaignConfigCacheService — warmTenant / vanished campaigns', () => {
  it('applies every campaign returned and reports success', async () => {
    const { service, client } = buildService();
    client.responses.set(42, {
      campaigns: [buildCampaign()],
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });

    await expect(service.warmTenant(42)).resolves.toBe(true);
    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toHaveLength(1);
  });

  it('returns false and leaves the cache untouched when the portal call fails', async () => {
    const { service, client } = buildService();
    await service.applyCampaignConfig(buildCampaign());
    client.responses.set(42, new Error('UNAVAILABLE: mock portal down'));

    await expect(service.warmTenant(42)).resolves.toBe(false);
    // Untouched: the previously-applied campaign still matches.
    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toHaveLength(1);
  });

  it('a campaign no longer returned by ListActiveCampaigns is marked not-active and stops matching', async () => {
    const { service, client, snapshotRepo } = buildService();
    const campaign = buildCampaign();
    await service.applyCampaignConfig(campaign);
    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toHaveLength(1);

    // Next ListActiveCampaigns for this tenant no longer includes CAMP1 at all (ended/archived).
    client.responses.set(42, {
      campaigns: [],
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });

    await expect(service.warmTenant(42)).resolves.toBe(true);
    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toEqual([]);
    expect(service.getCampaignConfig(42, 'CAMP1')).toMatchObject({ isActive: false });
    const persisted = snapshotRepo.rows.find((r) => r.campaign_code === 'CAMP1');
    expect(persisted?.is_active).toBe(false);
  });
});

describe('CampaignConfigCacheService — bootstrap', () => {
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

  it('succeeds when the portal is reachable, even with no local snapshot', async () => {
    const { service, client } = buildService();
    client.responses.set(42, {
      campaigns: [buildCampaign()],
      servedAt: new Date().toISOString(),
      sectionsReturned: [],
      sectionsOmitted: [],
    });

    await expect(service.bootstrap()).resolves.toBeUndefined();
    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toHaveLength(1);
  });

  it('boots from a stale local snapshot and logs a warning when the portal is unreachable', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, client, snapshotRepo } = buildService();
    snapshotRepo.rows.push({
      id: 'stale-1',
      tenant_id: 42,
      campaign_code: 'CAMP1',
      config_version: 'hash-1',
      is_active: true,
      payload: buildCampaign(),
      fetched_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    client.responses.set(42, new Error('UNAVAILABLE'));

    await expect(service.bootstrap()).resolves.toBeUndefined();
    expect(service.lookupByActivityCode(42, 'ACT_PURCHASE')).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('booting from the last known local snapshot'),
    );
  });

  it('TC-3: fails loudly when there is no local snapshot and the portal is unreachable', async () => {
    const { service, client } = buildService();
    client.responses.set(42, new Error('UNAVAILABLE'));

    await expect(service.bootstrap()).rejects.toThrow(/Cold start failed/);
  });
});
