/**
 * T-RTS-002 regression suite for `006_create_customer_reward_balance.ts`
 * (`brain-storm/02-DATA-MODEL.md` §6.1). See `schema-and-role.migration.spec.ts`'s header for
 * this suite's own conventions.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

describe('T-RTS-002 — customer_reward_balance migration', () => {
  let sequelize: Sequelize;
  let rewardFactId: string;
  const rewardEntryId = `RE-${randomUUID()}`;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();

    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO reward_tracking.reward_fact
         (reward_entry_id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
          campaign_code, reward_code, reward_category, reward_value, reward_value_unit,
          redeemed_at)
       VALUES
         (:rewardEntryId, :correlationId, 900001, 'cipher', :hash, 'CAMP1', 'RWD1', 'CASHBACK',
          5, 'USD', now())
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          rewardEntryId,
          correlationId: randomUUID(),
          hash: `hash-${randomUUID()}`,
        },
      },
    );
    rewardFactId = row.id;
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM reward_tracking.customer_reward_balance WHERE reward_fact_id = :id',
      { type: QueryTypes.RAW, replacements: { id: rewardFactId } },
    );
    await sequelize.query('DELETE FROM reward_tracking.reward_fact WHERE id = :id', {
      type: QueryTypes.RAW,
      replacements: { id: rewardFactId },
    });
    await sequelize.close();
  });

  it('the table, its FK to reward_fact and ix_crb_expiring exist', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_tracking' AND table_name = 'customer_reward_balance'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'reward_fact_id',
        'reward_kind',
        'promo_code_config_id',
        'promo_code_config_version_no',
        'status',
        'expires_at',
      ]),
    );

    const fks = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'reward_tracking.customer_reward_balance'::regclass AND contype = 'f'`,
      { type: QueryTypes.SELECT },
    );
    expect(fks.length).toBeGreaterThan(0);

    const indexes = await sequelize.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'reward_tracking' AND tablename = 'customer_reward_balance'`,
      { type: QueryTypes.SELECT },
    );
    expect(indexes.map((i) => i.indexname)).toContain('ix_crb_expiring');
  });

  it('a row referencing a real reward_fact.id inserts, and an unknown one is rejected by the FK', async () => {
    await expect(
      sequelize.query(
        `INSERT INTO reward_tracking.customer_reward_balance
           (reward_fact_id, tenant_id, customer_id_hash, campaign_code, reward_category,
            issued_value, issued_at)
         VALUES (:rewardFactId, 900001, :hash, 'CAMP1', 'CASHBACK', 5, now())`,
        {
          type: QueryTypes.RAW,
          replacements: { rewardFactId, hash: `hash-${randomUUID()}` },
        },
      ),
    ).resolves.toBeDefined();

    await expect(
      sequelize.query(
        `INSERT INTO reward_tracking.customer_reward_balance
           (reward_fact_id, tenant_id, customer_id_hash, campaign_code, reward_category,
            issued_value, issued_at)
         VALUES (:unknownId, 900001, :hash, 'CAMP1', 'CASHBACK', 5, now())`,
        {
          type: QueryTypes.RAW,
          replacements: { unknownId: randomUUID(), hash: `hash-${randomUUID()}` },
        },
      ),
    ).rejects.toMatchObject({
      parent: expect.objectContaining({ code: '23503' }),
    });
  });
});
