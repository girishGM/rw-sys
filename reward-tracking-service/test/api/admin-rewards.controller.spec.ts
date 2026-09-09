/**
 * T-RTS-031 — `AdminRewardsController`, exercised against the real Postgres 16 server (root
 * `CLAUDE.md`), never a mock/in-memory DB — same convention `customer-rewards.controller.spec.ts`
 * (T-RTS-030) already established. `campaign_reward_counter_shard`/`reward_fact` rows are seeded
 * through the real `RewardTrackingIngestionService` (T-RTS-010's own public class), never
 * hand-crafted `INSERT`s, so every test exercises the exact same pipeline a real event would go
 * through; `campaign_hierarchy_cache` rows ARE hand-inserted directly (this task's own header on
 * `campaign-summary-query.service.ts`: the live gRPC client never requests `CAPS` today, so a real
 * seeded cap can only come from a direct insert, not from re-running T-RTS-020's own client).
 * `PortalAdminAuthGuard` itself is already fully covered by `test/auth/portal-admin-auth.guard.spec.ts`
 * (T-RTS-032); this suite only needs the claim shape it produces on `request.portalAdmin`.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { Config } from '@/config/config.schema';
import {
  RewardTrackingIngestionService,
  type ApplyRewardTrackingEventInput,
} from '@/modules/ingestion/reward-tracking-ingestion.service';
import { InboundEventLogRepository } from '@/modules/ingestion/inbound-event-log.repository';
import { RewardFactRepository } from '@/modules/ingestion/reward-fact.repository';
import { CustomerRewardLedgerRepository } from '@/modules/ingestion/customer-reward-ledger.repository';
import { CampaignRewardCounterShardRepository } from '@/modules/ingestion/campaign-reward-counter-shard.repository';
import { ShardCountResolverService } from '@/modules/ingestion/shard-count-resolver.service';
import {
  CustomerIdCryptoService,
  loadCustomerIdCryptoKeyMaterial,
} from '@/modules/ingestion/customer-id-crypto.service';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/logging.module';
import type { RequestWithPortalAdmin } from '@/modules/auth/portal-admin-auth.guard';
import { CampaignSummaryQueryService } from '@/modules/api/campaign-summary-query.service';
import { CountedLevelQueryService } from '@/modules/api/counted-level-query.service';
import { AlertsQueryService } from '@/modules/api/alerts-query.service';
import { AdminRewardsController } from '@/modules/api/admin-rewards.controller';

const TENANT_ID = 800_000 + Math.floor(Math.random() * 9_999);
const OTHER_TENANT_ID = TENANT_ID + 1;

function realDbConfigService(): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
  } as Partial<Config>;
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

function baseInput(
  overrides: Partial<ApplyRewardTrackingEventInput> = {},
): ApplyRewardTrackingEventInput {
  return {
    rewardEntryId: randomUUID(),
    correlationId: randomUUID(),
    receivedChannel: 'REST',
    tenantId: TENANT_ID,
    tenantCode: 'T1',
    countryCode: 'MY',
    customerId: `customer-${randomUUID()}`,
    campaignCode: `CAMP-${randomUUID().slice(0, 8)}`,
    trackerCode: 'TRK1',
    trackerComponentCode: 'COMP1',
    merchantCode: 'MCH-GRAB',
    rewardCode: 'RWD1',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'MYR',
    rewardValue: '2.50',
    rewardValueUnit: 'MYR',
    externalSystemCode: null,
    externalReferenceId: null,
    promoCodeConfigId: null,
    promoCodeConfigVersionNo: null,
    redeemedAt: new Date(),
    expiresAt: null,
    ...overrides,
  };
}

function adminRequest(portalAdmin: RequestWithPortalAdmin['portalAdmin']): RequestWithPortalAdmin {
  return { portalAdmin } as unknown as RequestWithPortalAdmin;
}

const SUPER_ADMIN = {
  role: 'super_admin',
  tenantId: null,
  countryId: null,
  merchantId: null,
} as const;

interface HierarchyOverrides {
  countryId?: number;
  merchants?: Array<{ merchantId: number; merchantCode: string }>;
  caps?: Array<{
    capClass: string;
    scopeLevel: string;
    scopeRefId: number;
    unitType: string;
    unitCode: string;
    rewardType: string;
    maxTotalAmount: string;
    maxOccurrences: number;
    maxCustomers: number;
    onBreach: string;
    warnAtPercent: number;
  }>;
}

function buildHierarchy(
  tenantId: number,
  campaignCode: string,
  overrides: HierarchyOverrides = {},
) {
  return {
    campaignId: 1,
    campaignCode,
    tenantId,
    countryId: overrides.countryId ?? 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2026-12-31T00:00:00Z',
    budget: undefined,
    maxParticipants: 0,
    merchants: overrides.merchants ?? [],
    trackers: [],
    rules: [],
    rewards: [],
    caps: overrides.caps ?? [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    sectionsReturned: [],
    sectionsOmitted: [],
  };
}

describe('T-RTS-031 — AdminRewardsController', () => {
  let sequelize: Sequelize;
  let crypto: CustomerIdCryptoService;
  let controller: AdminRewardsController;
  let ingestion: RewardTrackingIngestionService;
  let shardCountResolver: ShardCountResolverService;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
    });
    await sequelize.authenticate();
    crypto = new CustomerIdCryptoService(loadCustomerIdCryptoKeyMaterial());

    const campaignSummary = new CampaignSummaryQueryService(sequelize);
    const countedLevel = new CountedLevelQueryService(sequelize);
    const alerts = new AlertsQueryService(sequelize, campaignSummary);
    controller = new AdminRewardsController(campaignSummary, countedLevel, alerts);
  });

  beforeEach(() => {
    const config = realDbConfigService();
    shardCountResolver = new ShardCountResolverService(config);
    ingestion = new RewardTrackingIngestionService(
      config,
      new InboundEventLogRepository(),
      new RewardFactRepository(),
      new CustomerRewardLedgerRepository(),
      new CampaignRewardCounterShardRepository(),
      shardCountResolver,
      crypto,
      new MetricsService(),
      new StructuredLoggerFactory(),
    );
  });

  afterEach(async () => {
    await ingestion.onModuleDestroy();
    await shardCountResolver.onModuleDestroy();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM reward_tracking.campaign_hierarchy_cache WHERE tenant_id IN (:tenantIds)',
      { type: QueryTypes.RAW, replacements: { tenantIds: [TENANT_ID, OTHER_TENANT_ID] } },
    );
    await sequelize.query(
      'DELETE FROM reward_tracking.campaign_reward_counter_shard WHERE tenant_id IN (:tenantIds)',
      { type: QueryTypes.RAW, replacements: { tenantIds: [TENANT_ID, OTHER_TENANT_ID] } },
    );
    await sequelize.query(
      'DELETE FROM reward_tracking.customer_reward_ledger WHERE tenant_id IN (:tenantIds)',
      { type: QueryTypes.RAW, replacements: { tenantIds: [TENANT_ID, OTHER_TENANT_ID] } },
    );
    await sequelize.query(
      'DELETE FROM reward_tracking.reward_fact WHERE tenant_id IN (:tenantIds)',
      { type: QueryTypes.RAW, replacements: { tenantIds: [TENANT_ID, OTHER_TENANT_ID] } },
    );
    await sequelize.query(
      `DELETE FROM reward_tracking.inbound_event_log WHERE payload->>'tenantId' IN (:tenantIdStrs)`,
      {
        type: QueryTypes.RAW,
        replacements: { tenantIdStrs: [String(TENANT_ID), String(OTHER_TENANT_ID)] },
      },
    );
    await sequelize.close();
  });

  async function insertHierarchyCacheRow(
    tenantId: number,
    campaignCode: string,
    overrides: HierarchyOverrides = {},
    isActive = true,
  ): Promise<void> {
    await sequelize.query(
      `INSERT INTO reward_tracking.campaign_hierarchy_cache
         (tenant_id, campaign_code, campaign_name, config_version, is_active, owner_contact, hierarchy, fetched_at, updated_at)
       VALUES (:tenantId, :campaignCode, NULL, NULL, :isActive, NULL, CAST(:hierarchy AS jsonb), now(), now())
       ON CONFLICT (tenant_id, campaign_code) DO UPDATE SET
         hierarchy = EXCLUDED.hierarchy, is_active = EXCLUDED.is_active, updated_at = now()`,
      {
        type: QueryTypes.RAW,
        replacements: {
          tenantId,
          campaignCode,
          isActive,
          hierarchy: JSON.stringify(buildHierarchy(tenantId, campaignCode, overrides)),
        },
      },
    );
  }

  // TC-1.
  it('TC-1: campaign summary shapes FIXED_AMOUNT/POINTS/PERCENTAGE per doc 03 §4, cap joined onto the summable row', async () => {
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;

    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '2.50' }));
    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '2.50' }));
    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '2.50' }));
    await ingestion.applyRewardTrackingEvent(
      baseInput({
        campaignCode,
        rewardCategory: 'POINTS',
        rewardKind: 'POINTS',
        rewardValue: '100',
        unitType: 'points',
        unitCode: null,
      }),
    );
    await ingestion.applyRewardTrackingEvent(
      baseInput({
        campaignCode,
        rewardCategory: 'VOUCHER',
        rewardKind: 'PERCENTAGE',
        rewardValue: '10',
        unitType: null,
        unitCode: null,
      }),
    );

    await insertHierarchyCacheRow(TENANT_ID, campaignCode, {
      caps: [
        {
          capClass: 'budget',
          scopeLevel: 'campaign',
          scopeRefId: 0,
          unitType: 'currency',
          unitCode: 'MYR',
          rewardType: 'CASHBACK',
          maxTotalAmount: '10.0000',
          maxOccurrences: 0,
          maxCustomers: 0,
          onBreach: 'alert_only',
          warnAtPercent: 70,
        },
      ],
    });

    const response = await controller.getCampaignSummary(adminRequest(SUPER_ADMIN), campaignCode);

    expect(response.campaignCode).toBe(campaignCode);
    expect(response.totals).toHaveLength(3);
    const totals = response.totals as unknown as Array<Record<string, unknown>>;

    const cashback = totals.find((t) => t.rewardKind === 'FIXED_AMOUNT')!;
    expect(cashback.totalValue).toBe('7.5000');
    expect(cashback.totalCount).toBe(3);
    expect(cashback.capMaxTotalAmount).toBe('10.0000');
    expect(cashback.consumptionPercent).toBe(75);
    expect(cashback.warnAtPercent).toBe(70);
    expect(cashback.warnTriggered).toBe(true);

    const points = totals.find((t) => t.rewardKind === 'POINTS')!;
    expect(points.totalValue).toBe('100.0000');
    expect(Object.prototype.hasOwnProperty.call(points, 'capMaxTotalAmount')).toBe(false);

    const percentage = totals.find((t) => t.rewardKind === 'PERCENTAGE')!;
    expect(Object.prototype.hasOwnProperty.call(percentage, 'totalValue')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(percentage, 'capMaxTotalAmount')).toBe(false);
    expect(percentage.totalCount).toBe(1);
  });

  it('campaign summary: a country_admin whose countryId matches the cached campaign succeeds', async () => {
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '1.00' }));
    await insertHierarchyCacheRow(TENANT_ID, campaignCode, { countryId: 42 });

    const response = await controller.getCampaignSummary(
      adminRequest({ role: 'country_admin', tenantId: null, countryId: 42, merchantId: null }),
      campaignCode,
    );
    expect(response.totals).toHaveLength(1);
  });

  it('negative auth (campaign summary): a country_admin whose countryId does NOT match is rejected', async () => {
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '1.00' }));
    await insertHierarchyCacheRow(TENANT_ID, campaignCode, { countryId: 42 });

    await expect(
      controller.getCampaignSummary(
        adminRequest({ role: 'country_admin', tenantId: null, countryId: 99, merchantId: null }),
        campaignCode,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  // TC-2.
  it('TC-2: merchant summary returns both reward kinds a merchant runs, correctly shaped', async () => {
    const merchantCode = `MCH-${randomUUID().slice(0, 6)}`;
    await ingestion.applyRewardTrackingEvent(
      baseInput({
        merchantCode,
        rewardCategory: 'CASHBACK',
        rewardKind: 'FIXED_AMOUNT',
        rewardValue: '2.50',
      }),
    );
    await ingestion.applyRewardTrackingEvent(
      baseInput({
        merchantCode,
        rewardCategory: 'CASHBACK',
        rewardKind: 'FIXED_AMOUNT',
        rewardValue: '2.50',
      }),
    );
    await ingestion.applyRewardTrackingEvent(
      baseInput({
        merchantCode,
        rewardCategory: 'VOUCHER',
        rewardKind: 'PERCENTAGE',
        rewardValue: '10',
        unitType: null,
        unitCode: null,
      }),
    );

    const response = await controller.getMerchantSummary(adminRequest(SUPER_ADMIN), merchantCode);

    expect(response.merchantCode).toBe(merchantCode);
    expect(response.totals).toHaveLength(2);
    const totals = response.totals as unknown as Array<Record<string, unknown>>;
    const cashback = totals.find((t) => t.rewardKind === 'FIXED_AMOUNT')!;
    expect(cashback.totalValue).toBe('5.0000');
    expect(cashback.totalCount).toBe(2);
    expect(cashback.distinctCustomers).toBeGreaterThanOrEqual(1);
    const voucher = totals.find((t) => t.rewardKind === 'PERCENTAGE')!;
    expect(Object.prototype.hasOwnProperty.call(voucher, 'totalValue')).toBe(false);
  });

  it('merchant summary: a merchant token whose claim resolves (via the hierarchy cache) to the requested code succeeds', async () => {
    const merchantCode = `MCH-${randomUUID().slice(0, 6)}`;
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    const merchantId = Math.floor(Math.random() * 1_000_000);
    await ingestion.applyRewardTrackingEvent(baseInput({ merchantCode, rewardValue: '3.00' }));
    await insertHierarchyCacheRow(TENANT_ID, campaignCode, {
      merchants: [{ merchantId, merchantCode }],
    });

    const response = await controller.getMerchantSummary(
      adminRequest({ role: 'merchant', tenantId: TENANT_ID, countryId: 1, merchantId }),
      merchantCode,
    );
    expect(response.merchantCode).toBe(merchantCode);
  });

  it('negative auth (merchant summary): a merchant token requesting a DIFFERENT merchant is rejected', async () => {
    const merchantCode = `MCH-${randomUUID().slice(0, 6)}`;
    const otherMerchantCode = `MCH-${randomUUID().slice(0, 6)}`;
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    const merchantId = Math.floor(Math.random() * 1_000_000);
    await insertHierarchyCacheRow(TENANT_ID, campaignCode, {
      merchants: [{ merchantId, merchantCode }],
    });

    await expect(
      controller.getMerchantSummary(
        adminRequest({ role: 'merchant', tenantId: TENANT_ID, countryId: 1, merchantId }),
        otherMerchantCode,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('negative auth (merchant summary): a merchant token with no resolvable cache entry fails closed', async () => {
    const merchantId = Math.floor(Math.random() * 1_000_000) + 5_000_000;
    await expect(
      controller.getMerchantSummary(
        adminRequest({ role: 'merchant', tenantId: TENANT_ID, countryId: 1, merchantId }),
        'MCH-UNRESOLVABLE',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('tenant summary: a super_admin (unrestricted) can request any tenant', async () => {
    await ingestion.applyRewardTrackingEvent(baseInput({ rewardValue: '1.00' }));

    const response = await controller.getTenantSummary(
      adminRequest(SUPER_ADMIN),
      String(TENANT_ID),
    );
    expect(response.tenantId).toBe(TENANT_ID);
    expect(response.totals.length).toBeGreaterThan(0);
  });

  // TC-3.
  it('TC-3: a tenant_admin token requesting a DIFFERENT tenant is rejected, never silently re-scoped', async () => {
    await expect(
      controller.getTenantSummary(
        adminRequest({ role: 'tenant_admin', tenantId: TENANT_ID, countryId: 1, merchantId: null }),
        String(OTHER_TENANT_ID),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('tenant summary: a tenant_admin token requesting their OWN tenant succeeds', async () => {
    await ingestion.applyRewardTrackingEvent(
      baseInput({ tenantId: OTHER_TENANT_ID, rewardValue: '1.00' }),
    );

    const response = await controller.getTenantSummary(
      adminRequest({
        role: 'tenant_admin',
        tenantId: OTHER_TENANT_ID,
        countryId: 1,
        merchantId: null,
      }),
      String(OTHER_TENANT_ID),
    );
    expect(response.tenantId).toBe(OTHER_TENANT_ID);
  });

  it('country summary: a super_admin (unrestricted) can request any country_code', async () => {
    const countryCode = 'MY';
    await ingestion.applyRewardTrackingEvent(baseInput({ countryCode, rewardValue: '1.00' }));

    const response = await controller.getCountrySummary(adminRequest(SUPER_ADMIN), countryCode);
    expect(response.countryCode).toBe(countryCode);
    expect(response.totals.length).toBeGreaterThan(0);
  });

  it('negative auth (country summary): a country_admin (concrete countryId) is rejected — documented gap, this service has no country_code<->countryId bridge', async () => {
    await expect(
      controller.getCountrySummary(
        adminRequest({ role: 'country_admin', tenantId: null, countryId: 1, merchantId: null }),
        'MY',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('getAlerts wires through to AlertsQueryService and returns its own shape', async () => {
    const response = await controller.getAlerts(adminRequest(SUPER_ADMIN));
    expect(Array.isArray(response.alerts)).toBe(true);
  });
});
