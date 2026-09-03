/**
 * T-RAP-010. Integration tests against the real local Postgres 16 server (root `CLAUDE.md`),
 * connected as the real least-privilege `rap_app` role — same real-DB convention
 * `test/database/migrations.spec.ts` (T-RAP-002) already established for this project. A large,
 * randomly-offset `tenant_id` per run is safe and never collides with real data (same reasoning
 * that file's own header gives).
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import {
  ActivityExternalCodeMapRepository,
  CampaignConfigSnapshotRepository,
} from '@/modules/campaign-cache/campaign-config-snapshot.repository';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-config.client';

const TENANT_ID = 910_000 + Math.floor(Math.random() * 89_999);

function samplePayload(overrides: Partial<CampaignConfigProto> = {}): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode: 'CAMP1',
    tenantId: TENANT_ID,
    countryId: 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    budget: { amount: '1000.00', currency: 'USD' },
    maxParticipants: 100,
    merchants: [],
    trackers: [],
    rules: [],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: [],
    sectionsOmitted: [],
    ...overrides,
  };
}

describe('CampaignConfigSnapshotRepository / ActivityExternalCodeMapRepository (real Postgres, rap_app role)', () => {
  let sequelize: Sequelize;
  let snapshotRepo: CampaignConfigSnapshotRepository;
  let externalCodeRepo: ActivityExternalCodeMapRepository;

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
    snapshotRepo = new CampaignConfigSnapshotRepository(sequelize);
    externalCodeRepo = new ActivityExternalCodeMapRepository(sequelize);
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.campaign_config_snapshot WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.activity_external_code_map WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.close();
  });

  it('upsert inserts a new snapshot row, findAll returns it', async () => {
    await snapshotRepo.upsert({
      tenantId: TENANT_ID,
      campaignCode: 'CAMP1',
      configVersion: 'hash-1',
      isActive: true,
      payload: samplePayload(),
    });

    const rows = await snapshotRepo.findAll();
    const row = rows.find((r) => r.tenant_id === TENANT_ID && r.campaign_code === 'CAMP1');
    expect(row).toBeDefined();
    expect(row?.is_active).toBe(true);
    expect(row?.config_version).toBe('hash-1');
    expect((row?.payload as CampaignConfigProto).campaignCode).toBe('CAMP1');
  });

  it('upsert on an existing (tenant_id, campaign_code) overwrites config_version/is_active/payload', async () => {
    await snapshotRepo.upsert({
      tenantId: TENANT_ID,
      campaignCode: 'CAMP1',
      configVersion: 'hash-2',
      isActive: false,
      payload: samplePayload({ status: 'paused', configHash: 'hash-2' }),
    });

    const rows = await snapshotRepo.findAll();
    const row = rows.find((r) => r.tenant_id === TENANT_ID && r.campaign_code === 'CAMP1');
    expect(row?.is_active).toBe(false);
    expect(row?.config_version).toBe('hash-2');
    expect((row?.payload as CampaignConfigProto).status).toBe('paused');
  });

  it('upsert inserts a new external-code mapping row, findAll returns it', async () => {
    await externalCodeRepo.upsert({
      tenantId: TENANT_ID,
      externalCode: 'TXN_PURCHASE',
      activityCode: 'ACT_PURCHASE',
    });

    const rows = await externalCodeRepo.findAll();
    const row = rows.find((r) => r.tenant_id === TENANT_ID && r.external_code === 'TXN_PURCHASE');
    expect(row?.activity_code).toBe('ACT_PURCHASE');
  });

  it('upsert on an existing (tenant_id, external_code) repoints activity_code (01-DATABASE.md §2)', async () => {
    await externalCodeRepo.upsert({
      tenantId: TENANT_ID,
      externalCode: 'TXN_PURCHASE',
      activityCode: 'ACT_PURCHASE_V2',
    });

    const rows = await externalCodeRepo.findAll();
    const matching = rows.filter(
      (r) => r.tenant_id === TENANT_ID && r.external_code === 'TXN_PURCHASE',
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].activity_code).toBe('ACT_PURCHASE_V2');
  });
});
