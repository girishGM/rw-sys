/**
 * T-RR-003 regression suite for `tenant_schema_config` (`01-DATABASE.md` §4). See
 * `reward-redemption-entry.migration.spec.ts`'s header (T-RR-002) for this suite's own
 * conventions.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

const TENANT_ID = 900_000 + Math.floor(Math.random() * 99_999);

describe('T-RR-003 — tenant_schema_config migration', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM reward_redemption.tenant_schema_config WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.close();
  });

  it('the table and its unique constraint exist with the expected shape', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_redemption' AND table_name = 'tenant_schema_config'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(['tenant_id', 'country_code', 'environment', 'schema_name']),
    );

    const constraints = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'reward_redemption.tenant_schema_config'::regclass AND contype = 'u'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints.map((c) => c.conname)).toContain('uq_tsc_tenant_country_env');
  });

  // A real per-tenant-schema-split row inserts and round-trips; a second row for the identical
  // (tenant_id, country_code, environment) triple is rejected by uq_tsc_tenant_country_env.
  it('a (tenant_id, country_code, environment) row inserts; a duplicate triple is rejected', async () => {
    const insert = () =>
      sequelize.query(
        `INSERT INTO reward_redemption.tenant_schema_config
           (tenant_id, tenant_code, country_code, environment, database_name, schema_name)
         VALUES (:tenant_id, 'T1', 'US', 'sandbox', 'reward_system', 'reward_redemption')`,
        { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
      );

    await expect(insert()).resolves.toBeDefined();
    await expect(insert()).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });
});
