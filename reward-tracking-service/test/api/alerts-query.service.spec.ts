/**
 * T-RTS-031 — `AlertsQueryService` (doc 04 §2.5). Real Postgres, same convention as every other
 * suite in this task and `test/api/admin-rewards.controller.spec.ts`'s own header. `reward_fact`/
 * `campaign_reward_counter_shard` rows come from the real `RewardTrackingIngestionService`;
 * `campaign_hierarchy_cache` rows (including their `caps`) are hand-inserted directly — see
 * `campaign-summary-query.service.ts`'s own header on why the live gRPC client can't supply a real
 * `CAPS` section today.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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
import { CampaignSummaryQueryService } from '@/modules/api/campaign-summary-query.service';
import { AlertsQueryService } from '@/modules/api/alerts-query.service';

const TENANT_ID = 810_000 + Math.floor(Math.random() * 9_999);
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

interface CapOverride {
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
}

function buildHierarchy(
  tenantId: number,
  campaignCode: string,
  overrides: { countryId?: number; caps?: CapOverride[] } = {},
) {
  return {
    campaignId: 1,
    campaignCode,
    tenantId,
    countryId: overrides.countryId ?? 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2026-12-31T00:00:00Z',
    maxParticipants: 0,
    merchants: [],
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

describe('T-RTS-031 — AlertsQueryService', () => {
  let sequelize: Sequelize;
  let crypto: CustomerIdCryptoService;
  let alertsService: AlertsQueryService;
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
    alertsService = new AlertsQueryService(sequelize, campaignSummary);
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
    overrides: { countryId?: number; caps?: CapOverride[] } = {},
  ): Promise<void> {
    await sequelize.query(
      `INSERT INTO reward_tracking.campaign_hierarchy_cache
         (tenant_id, campaign_code, campaign_name, config_version, is_active, owner_contact, hierarchy, fetched_at, updated_at)
       VALUES (:tenantId, :campaignCode, NULL, NULL, true, NULL, CAST(:hierarchy AS jsonb), now(), now())
       ON CONFLICT (tenant_id, campaign_code) DO UPDATE SET
         hierarchy = EXCLUDED.hierarchy, is_active = true, updated_at = now()`,
      {
        type: QueryTypes.RAW,
        replacements: {
          tenantId,
          campaignCode,
          hierarchy: JSON.stringify(buildHierarchy(tenantId, campaignCode, overrides)),
        },
      },
    );
  }

  const budgetCap = (overrides: Partial<CapOverride> = {}): CapOverride => ({
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
    ...overrides,
  });

  // TC-4.
  it('TC-4: a campaign at 75% consumption against a warnAtPercent=70 cap raises an alert', async () => {
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '2.50' }));
    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '2.50' }));
    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '2.50' }));
    await insertHierarchyCacheRow(TENANT_ID, campaignCode, { caps: [budgetCap()] });

    const alerts = await alertsService.listAlerts({
      tenantId: TENANT_ID,
      countryId: null,
      merchantId: null,
    });

    const alert = alerts.find((a) => a.campaignCode === campaignCode);
    expect(alert).toBeDefined();
    expect(alert!.consumptionPercent).toBe(75);
    expect(alert!.warnAtPercent).toBe(70);
    expect(alert!.warnTriggered).toBe(true);
    expect(alert!.rewardKind).toBe('FIXED_AMOUNT');
  });

  it('no alert is raised below the warn threshold', async () => {
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '1.00' }));
    await insertHierarchyCacheRow(TENANT_ID, campaignCode, { caps: [budgetCap()] });

    const alerts = await alertsService.listAlerts({
      tenantId: TENANT_ID,
      countryId: null,
      merchantId: null,
    });
    expect(alerts.find((a) => a.campaignCode === campaignCode)).toBeUndefined();
  });

  // TC-5.
  it('TC-5: a PERCENTAGE-only campaign never raises an alert, even against an (adversarial) matching cap', async () => {
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    await ingestion.applyRewardTrackingEvent(
      baseInput({
        campaignCode,
        rewardCategory: 'VOUCHER',
        rewardKind: 'PERCENTAGE',
        rewardValue: '95',
        unitType: null,
        unitCode: null,
      }),
    );
    // A nonsensical cap matching this row's unit (null/null) and category — proves R4 is enforced
    // structurally (no `totalValue`/`consumptionPercent` can ever exist on a PERCENTAGE row), not
    // just "because no cap happened to match" in this fixture.
    await insertHierarchyCacheRow(TENANT_ID, campaignCode, {
      caps: [budgetCap({ unitType: '', unitCode: '', rewardType: 'VOUCHER', warnAtPercent: 1 })],
    });

    const alerts = await alertsService.listAlerts({
      tenantId: TENANT_ID,
      countryId: null,
      merchantId: null,
    });
    expect(alerts.find((a) => a.campaignCode === campaignCode)).toBeUndefined();
  });

  it("alerts are scoped to the caller's own tenant — another tenant's breached campaign never appears", async () => {
    const ownCampaign = `CAMP-${randomUUID().slice(0, 8)}`;
    const otherCampaign = `CAMP-${randomUUID().slice(0, 8)}`;

    await ingestion.applyRewardTrackingEvent(
      baseInput({ campaignCode: ownCampaign, rewardValue: '9.00' }),
    );
    await insertHierarchyCacheRow(TENANT_ID, ownCampaign, { caps: [budgetCap()] });

    await ingestion.applyRewardTrackingEvent(
      baseInput({ tenantId: OTHER_TENANT_ID, campaignCode: otherCampaign, rewardValue: '9.00' }),
    );
    await insertHierarchyCacheRow(OTHER_TENANT_ID, otherCampaign, { caps: [budgetCap()] });

    const alerts = await alertsService.listAlerts({
      tenantId: TENANT_ID,
      countryId: null,
      merchantId: null,
    });

    expect(alerts.some((a) => a.campaignCode === ownCampaign)).toBe(true);
    expect(alerts.some((a) => a.campaignCode === otherCampaign)).toBe(false);
  });

  it('an inactive (markInactive-equivalent) cached campaign is never a live alert source', async () => {
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    await ingestion.applyRewardTrackingEvent(baseInput({ campaignCode, rewardValue: '9.00' }));
    await sequelize.query(
      `INSERT INTO reward_tracking.campaign_hierarchy_cache
         (tenant_id, campaign_code, is_active, hierarchy, fetched_at, updated_at)
       VALUES (:tenantId, :campaignCode, false, CAST(:hierarchy AS jsonb), now(), now())
       ON CONFLICT (tenant_id, campaign_code) DO UPDATE SET
         hierarchy = EXCLUDED.hierarchy, is_active = false, updated_at = now()`,
      {
        type: QueryTypes.RAW,
        replacements: {
          tenantId: TENANT_ID,
          campaignCode,
          hierarchy: JSON.stringify(
            buildHierarchy(TENANT_ID, campaignCode, { caps: [budgetCap()] }),
          ),
        },
      },
    );

    const alerts = await alertsService.listAlerts({
      tenantId: TENANT_ID,
      countryId: null,
      merchantId: null,
    });
    expect(alerts.find((a) => a.campaignCode === campaignCode)).toBeUndefined();
  });
});
