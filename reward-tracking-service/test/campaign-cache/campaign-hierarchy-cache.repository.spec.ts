/**
 * T-RTS-020. Integration tests against the real local Postgres 16 server (root `CLAUDE.md`),
 * connected as the real least-privilege `reward_tracking_app` role — same real-DB convention
 * `test/database/*.migration.spec.ts` (T-RTS-002) already established for this project. A large,
 * randomly-offset `tenant_id` per run is safe and never collides with real data.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { CampaignHierarchyCacheRepository } from '@/modules/campaign-cache/campaign-hierarchy-cache.repository';

const TENANT_ID = 920_000 + Math.floor(Math.random() * 79_999);

describe('CampaignHierarchyCacheRepository (real Postgres, reward_tracking_app role)', () => {
  let sequelize: Sequelize;
  let repository: CampaignHierarchyCacheRepository;

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
    repository = new CampaignHierarchyCacheRepository(sequelize);
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM reward_tracking.campaign_hierarchy_cache WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.close();
  });

  // TC-1.
  it('upsert inserts a new row, findOne returns it with names/hierarchy', async () => {
    await repository.upsert({
      tenantId: TENANT_ID,
      campaignCode: 'CAMP1',
      campaignName: null,
      configVersion: 'hash-1',
      isActive: true,
      ownerContact: null,
      hierarchy: { trackers: [{ trackerCode: 'TRK1' }] },
    });

    const row = await repository.findOne(TENANT_ID, 'CAMP1');
    expect(row).toBeDefined();
    expect(row?.is_active).toBe(true);
    expect(row?.config_version).toBe('hash-1');
    expect(row?.hierarchy).toEqual({ trackers: [{ trackerCode: 'TRK1' }] });
  });

  // TC-2 (the repository half of it — the client's own watch-driven refresh is exercised in
  // campaign-hierarchy.client.spec.ts).
  it('upsert on an existing (tenant_id, campaign_code) overwrites config_version/hierarchy/is_active, never merges', async () => {
    await repository.upsert({
      tenantId: TENANT_ID,
      campaignCode: 'CAMP1',
      campaignName: null,
      configVersion: 'hash-2',
      isActive: false,
      ownerContact: null,
      hierarchy: { trackers: [] },
    });

    const row = await repository.findOne(TENANT_ID, 'CAMP1');
    expect(row?.is_active).toBe(false);
    expect(row?.config_version).toBe('hash-2');
    expect(row?.hierarchy).toEqual({ trackers: [] });

    const rows = await repository.findAll();
    const matching = rows.filter((r) => r.tenant_id === TENANT_ID && r.campaign_code === 'CAMP1');
    expect(matching).toHaveLength(1);
  });

  it('a duplicate (tenant_id, campaign_code) pair never produces two rows (uq_chc_tenant_campaign)', async () => {
    await repository.upsert({
      tenantId: TENANT_ID,
      campaignCode: 'CAMP2',
      campaignName: null,
      configVersion: 'hash-a',
      isActive: true,
      ownerContact: null,
      hierarchy: {},
    });
    await repository.upsert({
      tenantId: TENANT_ID,
      campaignCode: 'CAMP2',
      campaignName: null,
      configVersion: 'hash-b',
      isActive: true,
      ownerContact: null,
      hierarchy: {},
    });

    const codes = await repository.findCampaignCodesForTenant(TENANT_ID);
    expect(codes.filter((code) => code === 'CAMP2')).toHaveLength(1);
  });

  it('markInactive flips is_active to false without deleting the row', async () => {
    await repository.upsert({
      tenantId: TENANT_ID,
      campaignCode: 'CAMP3',
      campaignName: null,
      configVersion: 'hash-3',
      isActive: true,
      ownerContact: null,
      hierarchy: {},
    });

    await repository.markInactive(TENANT_ID, 'CAMP3');

    const row = await repository.findOne(TENANT_ID, 'CAMP3');
    expect(row).toBeDefined();
    expect(row?.is_active).toBe(false);
  });

  it('markInactive on a campaign_code that was never cached is a no-op, never throws', async () => {
    await expect(repository.markInactive(TENANT_ID, 'NEVER-CACHED')).resolves.toBeUndefined();
  });

  it('findCampaignCodesForTenant returns every code for the tenant, active or not', async () => {
    const codes = await repository.findCampaignCodesForTenant(TENANT_ID);
    expect(codes).toEqual(expect.arrayContaining(['CAMP1', 'CAMP2', 'CAMP3']));
  });
});
