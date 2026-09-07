/**
 * T-RTS-002 regression suite for `008_create_service_config.ts`. See
 * `schema-and-role.migration.spec.ts`'s header for this suite's own conventions.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

describe('T-RTS-002 — service_config migration', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      "DELETE FROM reward_tracking.service_config WHERE config_key LIKE 'test.%'",
      {
        type: QueryTypes.RAW,
      },
    );
    await sequelize.close();
  });

  it('the table and its unique constraint exist with the expected shape', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_tracking' AND table_name = 'service_config'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'config_key',
        'scope_level',
        'scope_ref',
        'config_value',
        'value_type',
      ]),
    );

    const constraints = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'reward_tracking.service_config'::regclass AND contype = 'u'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints.map((c) => c.conname)).toContain('uq_sc_key_scope');
  });

  // TC-6: the seed row this migration's own up() inserts is present and resolves to 32.
  it('TC-6: tracking.campaignCounterShardCount seed row is present and resolves to 32', async () => {
    const [row] = await sequelize.query<{ config_value: string; value_type: string }>(
      `SELECT config_value, value_type FROM reward_tracking.service_config
         WHERE config_key = 'tracking.campaignCounterShardCount' AND scope_level = 'GLOBAL'`,
      { type: QueryTypes.SELECT },
    );
    expect(row).toBeDefined();
    expect(row.value_type).toBe('int');
    expect(Number(row.config_value)).toBe(32);
  });

  it('a CAMPAIGN-scope config key inserts once; a duplicate (config_key, scope_level, scope_ref) triple is rejected', async () => {
    const key = `test.${randomUUID().slice(0, 8)}`;
    const insert = () =>
      sequelize.query(
        `INSERT INTO reward_tracking.service_config (config_key, scope_level, scope_ref, config_value, value_type)
         VALUES (:key, 'CAMPAIGN', 'CAMP1', '30', 'int')`,
        { type: QueryTypes.RAW, replacements: { key } },
      );

    await expect(insert()).resolves.toBeDefined();
    await expect(insert()).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });
});
