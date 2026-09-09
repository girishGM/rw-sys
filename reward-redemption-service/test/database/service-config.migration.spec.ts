/**
 * T-RR-003 regression suite for `service_config` (`01-DATABASE.md` §6). See
 * `reward-redemption-entry.migration.spec.ts`'s header (T-RR-002) for this suite's own
 * conventions.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

describe('T-RR-003 — service_config migration', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      "DELETE FROM reward_redemption.service_config WHERE config_key LIKE 'test.%'",
      { type: QueryTypes.RAW },
    );
    await sequelize.close();
  });

  it('the table and its unique constraint exist with the expected shape', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_redemption' AND table_name = 'service_config'`,
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
         WHERE conrelid = 'reward_redemption.service_config'::regclass AND contype = 'u'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints.map((c) => c.conname)).toContain('uq_sc_key_scope');
  });

  // A real scope_ref (e.g. a campaign-scoped key) is what uq_sc_key_scope actually enforces —
  // like `dispatch_channel_config`'s own uq_dcc_scope, standard Postgres composite-unique
  // semantics never conflict a row containing a NULL column (confirmed empirically while
  // building this suite: two GLOBAL rows for the identical config_key, both scope_ref=NULL, do
  // NOT raise 23505) — asserting a rejection there would be asserting behavior this table
  // doesn't actually have. `01-DATABASE.md` §6 doesn't call this out the way §5's own note does,
  // but it's the identical constraint shape and the identical underlying Postgres rule.
  it('a CAMPAIGN-scope config key inserts once; a duplicate (config_key, scope_level, scope_ref) triple is rejected', async () => {
    const key = `test.${randomUUID().slice(0, 8)}`;
    const insert = () =>
      sequelize.query(
        `INSERT INTO reward_redemption.service_config (config_key, scope_level, scope_ref, config_value, value_type)
         VALUES (:key, 'CAMPAIGN', 'CAMP1', '30', 'int')`,
        { type: QueryTypes.RAW, replacements: { key } },
      );

    await expect(insert()).resolves.toBeDefined();
    await expect(insert()).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });

  it("a value_type=json row round-trips its config_value as stored text (parsing is the resolver module's own concern)", async () => {
    const key = `test.${randomUUID().slice(0, 8)}`;
    await sequelize.query(
      `INSERT INTO reward_redemption.service_config (config_key, scope_level, scope_ref, config_value, value_type)
       VALUES (:key, 'CAMPAIGN', 'CAMP1', :value, 'json')`,
      { type: QueryTypes.RAW, replacements: { key, value: JSON.stringify({ maxAttempts: 5 }) } },
    );

    const [row] = await sequelize.query<{ config_value: string; value_type: string }>(
      'SELECT config_value, value_type FROM reward_redemption.service_config WHERE config_key = :key',
      { type: QueryTypes.SELECT, replacements: { key } },
    );
    expect(row.value_type).toBe('json');
    expect(JSON.parse(row.config_value)).toEqual({ maxAttempts: 5 });
  });
});
