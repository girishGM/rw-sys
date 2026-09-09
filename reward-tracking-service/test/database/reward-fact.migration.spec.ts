/**
 * T-RTS-002 regression suite for `003_create_reward_fact.ts` (`brain-storm/02-DATA-MODEL.md`
 * §2.1). See `schema-and-role.migration.spec.ts`'s header for this suite's own conventions.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import type { RewardFactRow } from '@/database/models/reward-fact.model';

describe('T-RTS-002 — reward_fact migration', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('the table, its unique constraint and every §2.1 index exist', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_tracking' AND table_name = 'reward_fact'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'reward_entry_id',
        'reward_kind',
        'promo_code_config_id',
        'promo_code_config_version_no',
        'expires_at',
        'reward_lifecycle_status',
      ]),
    );

    const constraints = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'reward_tracking.reward_fact'::regclass AND contype = 'u'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints.map((c) => c.conname)).toContain('uq_rf_reward_entry');

    const indexes = await sequelize.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'reward_tracking' AND tablename = 'reward_fact'`,
      { type: QueryTypes.SELECT },
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        'ix_rf_customer_campaign_tracker',
        'ix_rf_expiry_watch',
        'ix_rf_merchant',
        'ix_rf_tenant',
        'ix_rf_country',
      ]),
    );
  });

  // R5: expires_at round-trips exactly the value inserted — this table never recomputes it.
  it('expires_at round-trips verbatim from the inserted value (R5 — never recomputed here)', async () => {
    const rewardEntryId = `RE-${randomUUID()}`;
    const expiresAt = new Date('2027-03-15T10:00:00.000Z');

    await sequelize.query(
      `INSERT INTO reward_tracking.reward_fact
         (reward_entry_id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
          campaign_code, reward_code, reward_category, reward_value, reward_value_unit,
          redeemed_at, expires_at)
       VALUES
         (:rewardEntryId, :correlationId, 900001, 'cipher', :hash, 'CAMP1', 'RWD1', 'CASHBACK',
          5, 'USD', now(), :expiresAt)`,
      {
        type: QueryTypes.RAW,
        replacements: {
          rewardEntryId,
          correlationId: randomUUID(),
          hash: `hash-${randomUUID()}`,
          expiresAt,
        },
      },
    );

    const [row] = await sequelize.query<RewardFactRow>(
      'SELECT * FROM reward_tracking.reward_fact WHERE reward_entry_id = :rewardEntryId',
      { type: QueryTypes.SELECT, replacements: { rewardEntryId } },
    );
    expect(new Date(row.expires_at as unknown as string).toISOString()).toBe(
      expiresAt.toISOString(),
    );

    await sequelize.query(
      'DELETE FROM reward_tracking.reward_fact WHERE reward_entry_id = :rewardEntryId',
      { type: QueryTypes.RAW, replacements: { rewardEntryId } },
    );
  });

  it('a second insert with the same reward_entry_id violates uq_rf_reward_entry', async () => {
    const rewardEntryId = `RE-${randomUUID()}`;
    const insert = () =>
      sequelize.query(
        `INSERT INTO reward_tracking.reward_fact
           (reward_entry_id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
            campaign_code, reward_code, reward_category, reward_value, reward_value_unit,
            redeemed_at)
         VALUES
           (:rewardEntryId, :correlationId, 900001, 'cipher', :hash, 'CAMP1', 'RWD1', 'CASHBACK',
            5, 'USD', now())`,
        {
          type: QueryTypes.RAW,
          replacements: {
            rewardEntryId,
            correlationId: randomUUID(),
            hash: `hash-${randomUUID()}`,
          },
        },
      );

    await expect(insert()).resolves.toBeDefined();
    await expect(insert()).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });

    await sequelize.query(
      'DELETE FROM reward_tracking.reward_fact WHERE reward_entry_id = :rewardEntryId',
      { type: QueryTypes.RAW, replacements: { rewardEntryId } },
    );
  });
});
