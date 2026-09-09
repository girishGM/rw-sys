/**
 * T-RR-036 — `NotificationService`. Unit-tested against a fake `CampaignConfigCache` (the real
 * gRPC/cache behaviour is already covered by T-RR-022's own `campaign-config.cache.spec.ts`/
 * `campaign-config.client.spec.ts`) and a fake `NotificationLogRepository` (the real transactional/
 * persistence behaviour is covered by this task's own `notification-log.repository.spec.ts`,
 * against the real Postgres server) — this file isolates `NotificationService`'s own resolution,
 * gating and never-throws logic.
 *
 * `NOTIFICATION_ENABLED_RESOLVER` — see `notification.service.ts`'s own header for the full
 * reasoning: the shipped default (`NO_NOTIFICATION_FLAG_YET_RESOLVER`) always returns `false`
 * because `campaign_config.v1.proto` genuinely carries no notification-enabled field anywhere
 * today. TC-1 substitutes a fake resolver via the same constructor seam to exercise the real
 * write-path/metric-increment logic end to end, exactly as that header describes.
 */
import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  NO_NOTIFICATION_FLAG_YET_RESOLVER,
  NotificationService,
  buildWouldBePayload,
  type NotificationEnabledResolver,
  type RedemptionOutcomeContext,
} from '@/modules/notification/notification.service';
import type { NotificationLogRepository } from '@/modules/notification/notification-log.repository';
import { NotificationMetricsService } from '@/modules/notification/notification-metrics.service';
import type { CampaignConfigCache } from '@/modules/processing/campaign-config.cache';
import type {
  BoundRewardProto,
  CampaignConfigProto,
} from '@/modules/processing/campaign-config.client';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

function buildBoundReward(overrides: Partial<BoundRewardProto> = {}): BoundRewardProto {
  return {
    rewardId: 1,
    rewardVersionId: 1,
    versionNo: 1,
    systemCode: 'RWD1',
    rewardType: 'CASHBACK',
    deliveryMode: 'API',
    policiesJson: '{}',
    unitType: 'currency',
    unitCode: 'USD',
    level: 'campaign',
    refId: 0,
    status: 'active',
    ...overrides,
  };
}

function buildConfig(overrides: Partial<CampaignConfigProto> = {}): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode: 'CAMP1',
    tenantId: 1,
    countryId: 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    budget: { amount: '1000.00', currency: 'USD' },
    maxParticipants: 100,
    merchants: [],
    trackers: [],
    rewards: [buildBoundReward()],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'REWARDS', 'CAPS'],
    sectionsOmitted: [],
    ...overrides,
  };
}

function buildEntry(overrides: Partial<RewardRedemptionEntryRow> = {}): RewardRedemptionEntryRow {
  return {
    id: 'entry-1',
    correlation_id: 'corr-1',
    tenant_id: 1,
    customer_id_encrypted: 'ciphertext-should-never-be-read-by-this-service',
    customer_id_hash: 'hash-abc123',
    customer_id_type: 'EMAIL',
    activity_performed_date: new Date('2026-01-05T00:00:00.000Z'),
    transaction_type: null,
    activity_code: 'ACT1',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: '10.00',
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 'notification test fixture',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'CASHBACK',
    reward_value: '5.00',
    reward_value_unit: 'USD',
    reward_entry_date: new Date('2026-01-05T00:00:00.000Z'),
    completion_cycle: 1,
    reward_processed_env: 'development',
    country_code: 'MY',
    tenant_code: 'TEN-TEST',
    ingestion_channel: 'REST',
    status: 'completed',
    retry_count: 0,
    next_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    last_attempted_at: null,
    external_system_code: 'CORE_BANKING',
    external_reference_id: 'REF-1',
    redeemed_at: new Date('2026-01-05T00:01:00.000Z'),
    created_at: new Date('2026-01-05T00:00:00.000Z'),
    updated_at: new Date('2026-01-05T00:01:00.000Z'),
    ...overrides,
  };
}

const OUTCOME: RedemptionOutcomeContext = {
  externalSystemCode: 'CORE_BANKING',
  externalReferenceId: 'REF-1',
};

const ALWAYS_ENABLED: NotificationEnabledResolver = () => true;

function build(options: {
  config?: CampaignConfigProto | null;
  resolver?: NotificationEnabledResolver;
  createImpl?: jest.Mock;
}): {
  service: NotificationService;
  get: jest.Mock;
  create: jest.Mock;
  metrics: NotificationMetricsService;
} {
  const get =
    options.config === null
      ? jest.fn().mockRejectedValue(new Error('NOT_FOUND: no such campaign'))
      : jest.fn().mockResolvedValue(options.config ?? buildConfig());
  const cache = { get } as unknown as CampaignConfigCache;

  const create = options.createImpl ?? jest.fn().mockResolvedValue({ id: 'log-1' });
  const repository = { create } as unknown as NotificationLogRepository;

  const metrics = new NotificationMetricsService();

  const service = new NotificationService(
    cache,
    repository,
    metrics,
    options.resolver ?? NO_NOTIFICATION_FLAG_YET_RESOLVER,
  );

  return { service, get, create, metrics };
}

describe('T-RR-036 — NotificationService', () => {
  // TC-1.
  it('TC-1: notifications enabled for this reward — writes a notification_log row, increments the metric', async () => {
    const { service, create, metrics } = build({ resolver: ALWAYS_ENABLED });
    const entry = buildEntry();

    await service.notifyIfConfigured(entry, OUTCOME);

    expect(create).toHaveBeenCalledTimes(1);
    const [row, client] = create.mock.calls[0];
    expect(row).toEqual({
      rewardEntryId: entry.id,
      tenantId: entry.tenant_id,
      customerIdHash: entry.customer_id_hash,
      campaignCode: entry.campaign_code,
      rewardCode: entry.reward_code,
      channel: 'PUSH',
      wouldBePayload: buildWouldBePayload(entry, OUTCOME),
    });
    expect(client).toBeUndefined();
    expect(metrics.getNotificationLoggedCount()).toBe(1);
  });

  // TC-2.
  it('TC-2: notifications disabled — no row written, no metric increment, no error', async () => {
    const { service, create, metrics } = build({ resolver: () => false });
    const entry = buildEntry();

    await expect(service.notifyIfConfigured(entry, OUTCOME)).resolves.toBeUndefined();

    expect(create).not.toHaveBeenCalled();
    expect(metrics.getNotificationLoggedCount()).toBe(0);
  });

  // TC-3.
  it('TC-3: campaign config cache has no entry at all (a resolution miss) — treated as not configured, never throws', async () => {
    const { service, create, metrics, get } = build({
      config: null,
      // Even a resolver that would say "enabled" for a real BoundReward never gets a real one here
      // — the miss must short-circuit before resolveEnabled ever sees a truthy match.
      resolver: (boundReward) => boundReward !== undefined,
    });
    const entry = buildEntry();

    await expect(service.notifyIfConfigured(entry, OUTCOME)).resolves.toBeUndefined();

    expect(get).toHaveBeenCalledWith(entry.tenant_id, entry.campaign_code);
    expect(create).not.toHaveBeenCalled();
    expect(metrics.getNotificationLoggedCount()).toBe(0);
  });

  it('TC-3 (sibling): no BoundReward at any level this entry could resolve to — treated as not configured, never throws', async () => {
    const config = buildConfig({ rewards: [] });
    const { service, create } = build({
      config,
      resolver: (boundReward) => boundReward !== undefined,
    });
    const entry = buildEntry();

    await expect(service.notifyIfConfigured(entry, OUTCOME)).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  // TC-4.
  it('TC-4: would_be_payload never carries plaintext/encrypted customerId — customerIdHash only', () => {
    const entry = buildEntry();

    const payload = buildWouldBePayload(entry, OUTCOME);

    expect(payload.customerIdHash).toBe(entry.customer_id_hash);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(entry.customer_id_encrypted);
    expect(payload).not.toHaveProperty('customerId');
    expect(payload).not.toHaveProperty('customerIdEncrypted');
  });

  // TC-5.
  it("TC-5: notification_log.channel is always 'PUSH'", async () => {
    const { service, create } = build({ resolver: ALWAYS_ENABLED });
    const entry = buildEntry();

    await service.notifyIfConfigured(entry, OUTCOME);

    const [row] = create.mock.calls[0];
    expect(row.channel).toBe('PUSH');
    expect(buildWouldBePayload(entry, OUTCOME).channel).toBe('PUSH');
  });

  // TC-6.
  it('TC-6: a thrown DB error writing notification_log is logged, never propagated', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const createImpl = jest.fn().mockRejectedValue(new Error('simulated DB error'));
    const { service } = build({ resolver: ALWAYS_ENABLED, createImpl });
    const entry = buildEntry();

    await expect(service.notifyIfConfigured(entry, OUTCOME)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('simulated DB error'));
    errorSpy.mockRestore();
  });

  // TC-7.
  it('TC-7: an externally-supplied transaction handle is forwarded verbatim to the repository', async () => {
    const { service, create } = build({ resolver: ALWAYS_ENABLED });
    const entry = buildEntry();
    const fakeClient = { query: jest.fn() } as unknown as PoolClient;

    await service.notifyIfConfigured(entry, OUTCOME, fakeClient);

    const [, client] = create.mock.calls[0];
    expect(client).toBe(fakeClient);
  });

  // TC-8.
  it('TC-8: two redemptions for the same customer, both enabled — two independent calls, no dedup/merge', async () => {
    const { service, create, metrics } = build({ resolver: ALWAYS_ENABLED });
    const first = buildEntry({ id: 'entry-1' });
    const second = buildEntry({ id: 'entry-2' });

    await service.notifyIfConfigured(first, OUTCOME);
    await service.notifyIfConfigured(second, OUTCOME);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].rewardEntryId).toBe('entry-1');
    expect(create.mock.calls[1][0].rewardEntryId).toBe('entry-2');
    expect(metrics.getNotificationLoggedCount()).toBe(2);
  });
});
