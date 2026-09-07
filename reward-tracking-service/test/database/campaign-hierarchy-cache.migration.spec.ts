/**
 * T-RTS-002 regression suite for `007_create_campaign_hierarchy_cache.ts`
 * (`brain-storm/02-DATA-MODEL.md` §7 — see that migration's own header for the "inferred, not
 * copied verbatim" note). See `schema-and-role.migration.spec.ts`'s header for this suite's own
 * conventions.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

describe('T-RTS-002 — campaign_hierarchy_cache migration', () => {
  let sequelize: Sequelize;
  const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM reward_tracking.campaign_hierarchy_cache WHERE campaign_code = :campaignCode',
      { type: QueryTypes.RAW, replacements: { campaignCode } },
    );
    await sequelize.close();
  });

  const insertRow = () =>
    sequelize.query(
      `INSERT INTO reward_tracking.campaign_hierarchy_cache
         (tenant_id, campaign_code, campaign_name, hierarchy)
       VALUES (900001, :campaignCode, 'Test Campaign', :hierarchy)`,
      {
        type: QueryTypes.RAW,
        replacements: { campaignCode, hierarchy: JSON.stringify({ trackers: [] }) },
      },
    );

  it('the table, its unique constraint and ix_chc_active exist', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_tracking' AND table_name = 'campaign_hierarchy_cache'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'campaign_code',
        'campaign_name',
        'is_active',
        'owner_contact',
        'hierarchy',
      ]),
    );

    const constraints = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'reward_tracking.campaign_hierarchy_cache'::regclass AND contype = 'u'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints.map((c) => c.conname)).toContain('uq_chc_tenant_campaign');

    const indexes = await sequelize.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'reward_tracking' AND tablename = 'campaign_hierarchy_cache'`,
      { type: QueryTypes.SELECT },
    );
    expect(indexes.map((i) => i.indexname)).toContain('ix_chc_active');
  });

  it('a duplicate (tenant_id, campaign_code) pair violates uq_chc_tenant_campaign', async () => {
    await expect(insertRow()).resolves.toBeDefined();
    await expect(insertRow()).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });
});
