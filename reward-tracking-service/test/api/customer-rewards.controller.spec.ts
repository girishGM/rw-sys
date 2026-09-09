/**
 * T-RTS-030 — `CustomerRewardsController`, exercised against the real Postgres 16 server
 * (root `CLAUDE.md`), never a mock/in-memory DB — same convention
 * `reward-tracking-ingestion.service.spec.ts` (T-RTS-010) already established for this project.
 * Seeds real data through the real `RewardTrackingIngestionService` (T-RTS-010's own public,
 * exported class) rather than hand-crafted `INSERT`s, so every test is exercising the exact same
 * pipeline a real event would go through. The controller is instantiated directly (not through
 * Nest's HTTP layer) with a hand-built `RequestWithCustomerAuth`-shaped object — `CustomerAuthGuard`
 * itself is already fully covered by `test/auth/customer-auth.guard.spec.ts` (T-RTS-032); this suite
 * only needs the claim shape it produces.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
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
import type { RequestWithCustomerAuth } from '@/modules/auth/customer-auth.guard';
import { CustomerRewardLedgerQueryService } from '@/modules/api/customer-reward-ledger-query.service';
import { CustomerRewardBalanceRepository } from '@/modules/api/customer-reward-balance.repository';
import { CustomerRewardsController } from '@/modules/api/customer-rewards.controller';

const TENANT_ID = 900_000 + Math.floor(Math.random() * 9_999);

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
    countryCode: 'US',
    customerId: `customer-${randomUUID()}`,
    campaignCode: `CAMP-${randomUUID().slice(0, 8)}`,
    trackerCode: 'TRK1',
    trackerComponentCode: 'COMP1',
    merchantCode: null,
    rewardCode: 'RWD1',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'USD',
    rewardValue: '5.00',
    rewardValueUnit: 'USD',
    externalSystemCode: null,
    externalReferenceId: null,
    promoCodeConfigId: null,
    promoCodeConfigVersionNo: null,
    redeemedAt: new Date(),
    expiresAt: null,
    ...overrides,
  };
}

function authRequest(customerId: string): RequestWithCustomerAuth {
  return {
    customerAuth: { tenantId: TENANT_ID, customerId },
  } as unknown as RequestWithCustomerAuth;
}

describe('T-RTS-030 — CustomerRewardsController', () => {
  let sequelize: Sequelize;
  let crypto: CustomerIdCryptoService;
  let controller: CustomerRewardsController;
  let balanceRepository: CustomerRewardBalanceRepository;
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
    balanceRepository = new CustomerRewardBalanceRepository(sequelize);
    controller = new CustomerRewardsController(
      new CustomerRewardLedgerQueryService(sequelize),
      balanceRepository,
      crypto,
    );
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
      'DELETE FROM reward_tracking.customer_reward_balance WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM reward_tracking.campaign_reward_counter_shard WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM reward_tracking.customer_reward_ledger WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.query('DELETE FROM reward_tracking.reward_fact WHERE tenant_id = :tenantId', {
      type: QueryTypes.RAW,
      replacements: { tenantId: TENANT_ID },
    });
    await sequelize.query(
      `DELETE FROM reward_tracking.inbound_event_log
         WHERE payload->>'tenantId' = :tenantIdStr`,
      { type: QueryTypes.RAW, replacements: { tenantIdStr: String(TENANT_ID) } },
    );
    await sequelize.close();
  });

  // TC-1.
  it('TC-1: summary endpoint shows totalValue only on the FIXED_AMOUNT row, never on the PERCENTAGE one', async () => {
    const customerId = `customer-${randomUUID()}`;
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;

    await ingestion.applyRewardTrackingEvent(
      baseInput({
        customerId,
        campaignCode,
        rewardCategory: 'CASHBACK',
        rewardKind: 'FIXED_AMOUNT',
      }),
    );
    await ingestion.applyRewardTrackingEvent(
      baseInput({
        customerId,
        campaignCode,
        rewardCategory: 'VOUCHER',
        rewardKind: 'PERCENTAGE',
        rewardValue: '10',
        unitType: null,
        unitCode: null,
      }),
    );

    const response = await controller.getSummary(authRequest(customerId), customerId, campaignCode);

    expect(response.customerId).toBe(customerId);
    expect(response.campaignCode).toBe(campaignCode);
    expect(response.components).toHaveLength(2);

    const components = response.components as Array<Record<string, unknown>>;
    const fixedAmount = components.find((c) => c.rewardKind === 'FIXED_AMOUNT')!;
    const percentage = components.find((c) => c.rewardKind === 'PERCENTAGE')!;

    expect(fixedAmount.trackerCode).toBe('TRK1');
    expect(fixedAmount.componentCode).toBe('COMP1');
    expect(Object.prototype.hasOwnProperty.call(fixedAmount, 'totalValue')).toBe(true);
    expect(fixedAmount.totalValue).toBe('5.0000');
    expect(fixedAmount.totalCount).toBe(1);

    expect(Object.prototype.hasOwnProperty.call(percentage, 'totalValue')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(percentage, 'unitType')).toBe(false);
    expect(percentage.totalCount).toBe(1);
    expect(percentage.averageRatePercent).toBe('10.00');
  });

  // TC-5.
  it('TC-5: reward_kind IS NULL row shows totalCount only, never a fabricated totalValue', async () => {
    const customerId = `customer-${randomUUID()}`;
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;

    await ingestion.applyRewardTrackingEvent(
      baseInput({ customerId, campaignCode, rewardKind: null, unitType: null, unitCode: null }),
    );

    const response = await controller.getSummary(authRequest(customerId), customerId, campaignCode);

    expect(response.components).toHaveLength(1);
    const [component] = response.components as Array<Record<string, unknown>>;
    expect(component.rewardKind).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(component, 'totalValue')).toBe(false);
    expect(component.totalCount).toBe(1);
  });

  // TC-2.
  it('TC-2: tracker-level totals correctly span two campaigns', async () => {
    const customerId = `customer-${randomUUID()}`;
    const trackerCode = `TRK-${randomUUID().slice(0, 8)}`;

    await ingestion.applyRewardTrackingEvent(
      baseInput({
        customerId,
        trackerCode,
        campaignCode: `CAMP-${randomUUID().slice(0, 8)}`,
        rewardValue: '3.00',
      }),
    );
    await ingestion.applyRewardTrackingEvent(
      baseInput({
        customerId,
        trackerCode,
        campaignCode: `CAMP-${randomUUID().slice(0, 8)}`,
        rewardValue: '4.00',
      }),
    );

    const response = await controller.getTrackerTotals(
      authRequest(customerId),
      customerId,
      trackerCode,
    );

    expect(response.trackerCode).toBe(trackerCode);
    expect(response.totals).toHaveLength(1);
    expect(response.totals[0]).toMatchObject({
      rewardCategory: 'CASHBACK',
      rewardKind: 'FIXED_AMOUNT',
      totalValue: '7.0000',
      totalCount: 2,
    });
  });

  it('campaign-level totals scope to one campaign only', async () => {
    const customerId = `customer-${randomUUID()}`;
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    const otherCampaignCode = `CAMP-${randomUUID().slice(0, 8)}`;

    await ingestion.applyRewardTrackingEvent(
      baseInput({ customerId, campaignCode, rewardValue: '2.00' }),
    );
    await ingestion.applyRewardTrackingEvent(
      baseInput({ customerId, campaignCode: otherCampaignCode, rewardValue: '99.00' }),
    );

    const response = await controller.getCampaignTotals(
      authRequest(customerId),
      customerId,
      campaignCode,
    );

    expect(response.totals).toHaveLength(1);
    expect(response.totals[0]).toMatchObject({ totalValue: '2.0000', totalCount: 1 });
  });

  // TC-4.
  it('TC-4: a reward_fact row with expires_at IS NULL never produces a customer_reward_balance row', async () => {
    const customerId = `customer-${randomUUID()}`;

    const result = await ingestion.applyRewardTrackingEvent(
      baseInput({ customerId, expiresAt: null }),
    );

    const inserted = await balanceRepository.populateMissing({
      tenantId: TENANT_ID,
      customerIdHash: crypto.hash(customerId),
    });
    expect(inserted).toBe(0);

    const [{ count }] = await sequelize.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.customer_reward_balance WHERE reward_fact_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: result.rewardFact.id } },
    );
    expect(count).toBe('0');
  });

  // TC-3.
  it('TC-3: expiring endpoint returns a POINTS and a PROMO_CODE balance, message text branched by kind', async () => {
    const customerId = `customer-${randomUUID()}`;
    const expiresSoon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    await ingestion.applyRewardTrackingEvent(
      baseInput({
        customerId,
        rewardCategory: 'POINTS',
        rewardKind: 'POINTS',
        rewardValue: '100',
        unitType: 'points',
        unitCode: null,
        expiresAt: expiresSoon,
      }),
    );
    await ingestion.applyRewardTrackingEvent(
      baseInput({
        customerId,
        rewardCategory: 'VOUCHER',
        rewardKind: 'PROMO_CODE',
        rewardValue: '0',
        rewardCode: 'SAVE10-X7K2Q',
        unitType: null,
        unitCode: null,
        expiresAt: expiresSoon,
      }),
    );

    const response = await controller.getExpiring(authRequest(customerId), '30');

    expect(response.expiring).toHaveLength(2);
    const rows = response.expiring as Array<Record<string, unknown>>;
    const points = rows.find((r) => r.rewardKind === 'POINTS')!;
    const promo = rows.find((r) => r.rewardKind === 'PROMO_CODE')!;

    expect(points.issuedValue).toBe('100.0000');
    expect(points.message).toBe(
      `100 points expire on ${(points.expiresAt as Date).toISOString().slice(0, 10)} — use them soon.`,
    );

    expect(promo.message).toContain('promo code SAVE10-X7K2Q');
    expect(promo.message).not.toMatch(/points/i);
    expect(promo.message).not.toContain('%-off');
  });

  it('an expiring balance outside the window is not returned', async () => {
    const customerId = `customer-${randomUUID()}`;
    const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);

    await ingestion.applyRewardTrackingEvent(baseInput({ customerId, expiresAt: farFuture }));

    const response = await controller.getExpiring(authRequest(customerId), '30');
    expect(response.expiring).toHaveLength(0);
  });

  it('getExpiring rejects a missing withinDays with a 400', async () => {
    await expect(
      controller.getExpiring(authRequest(`customer-${randomUUID()}`), undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it.each(['0', '-5', 'not-a-number'])(
    'getExpiring rejects an invalid withinDays=%s with a 400',
    async (value) => {
      await expect(
        controller.getExpiring(authRequest(`customer-${randomUUID()}`), value),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it('PERCENTAGE expiring message phrases a rate, never a fabricated currency/points amount', async () => {
    const customerId = `customer-${randomUUID()}`;
    const expiresSoon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    await ingestion.applyRewardTrackingEvent(
      baseInput({
        customerId,
        rewardCategory: 'VOUCHER',
        rewardKind: 'PERCENTAGE',
        rewardValue: '10',
        unitType: null,
        unitCode: null,
        expiresAt: expiresSoon,
      }),
    );

    const response = await controller.getExpiring(authRequest(customerId), '30');
    const [row] = response.expiring as Array<Record<string, unknown>>;
    expect(row.message).toContain('10%-off voucher');
    expect(row.message).not.toMatch(/points|MYR|USD/i);
  });
});
