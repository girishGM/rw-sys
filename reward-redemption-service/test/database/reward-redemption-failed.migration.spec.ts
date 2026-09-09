/**
 * T-RR-002 regression suite for `reward_redemption_failed` (`01-DATABASE.md` §2). See
 * `reward-redemption-entry.migration.spec.ts`'s header for this suite's own conventions
 * (real Postgres, migration-privileged connection, tenant_id randomized per run).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

const TENANT_ID = 900_000 + Math.floor(Math.random() * 99_999);

async function insertEntry(sequelize: Sequelize, id: string): Promise<void> {
  await sequelize.query(
    `INSERT INTO reward_redemption.reward_redemption_entry
       (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
        activity_performed_date, activity_type, activity_category, activity_value,
        activity_value_unit, channel, activity_performed_env, activity_name, campaign_code,
        tracker_code, tracker_component_code, reward_code, reward_category, reward_value,
        reward_value_unit, reward_entry_date, reward_processed_env, ingestion_channel, status)
     VALUES
       (:id, :correlation_id, :tenant_id, 'ciphertext-placeholder', :customer_id_hash, 'EMAIL',
        now(), 'PURCHASE', 'SPEND', 10, 'USD', 'WEB', 'PROD', 't-rr-002 failed-ledger fixture',
        'CAMP1', 'TRK1', 'COMP1', 'RWD1', 'CASHBACK', 5, 'USD', now(), 'development', 'REST',
        'failed')`,
    {
      type: QueryTypes.RAW,
      replacements: {
        id,
        correlation_id: randomUUID(),
        tenant_id: TENANT_ID,
        customer_id_hash: `hash-${randomUUID()}`,
      },
    },
  );
}

describe('T-RR-002 — reward_redemption_failed migration', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM reward_redemption.reward_redemption_failed WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.close();
  });

  it('the table and its FK/index exist with the expected shape', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_redemption' AND table_name = 'reward_redemption_failed'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(['id', 'reward_entry_id', 'total_attempts', 'final_error_message']),
    );

    const constraints = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'reward_redemption.reward_redemption_failed'::regclass AND contype = 'f'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints.map((c) => c.conname)).toContain('fk_rrf_entry');
  });

  // TC-3: a failed row whose reward_entry_id matches a real reward_redemption_entry row succeeds.
  it('TC-3: inserting a failed row referencing an existing entry succeeds', async () => {
    const entryId = randomUUID();
    await insertEntry(sequelize, entryId);

    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO reward_redemption.reward_redemption_failed
         (reward_entry_id, tenant_id, campaign_code, reward_code, total_attempts, final_error_message)
       VALUES (:reward_entry_id, :tenant_id, 'CAMP1', 'RWD1', 5, 'exhausted retries')
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { reward_entry_id: entryId, tenant_id: TENANT_ID },
      },
    );
    expect(row.id).toBeDefined();
  });

  // TC-4 (negative): a reward_entry_id with no matching reward_redemption_entry row is rejected
  // with a real 23503 foreign-key violation.
  it('TC-4: inserting a failed row referencing a non-existent entry raises a 23503 FK violation', async () => {
    await expect(
      sequelize.query(
        `INSERT INTO reward_redemption.reward_redemption_failed
           (reward_entry_id, tenant_id, campaign_code, reward_code, total_attempts, final_error_message)
         VALUES (:reward_entry_id, :tenant_id, 'CAMP1', 'RWD1', 5, 'exhausted retries')`,
        {
          type: QueryTypes.RAW,
          replacements: { reward_entry_id: randomUUID(), tenant_id: TENANT_ID },
        },
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeForeignKeyConstraintError',
      parent: expect.objectContaining({ code: '23503' }),
    });
  });
});
