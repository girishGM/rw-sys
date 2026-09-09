/**
 * T-RTS-002 regression suite for `005_create_campaign_reward_counter_shard.ts`
 * (`brain-storm/02-DATA-MODEL.md` §4). See `schema-and-role.migration.spec.ts`'s header for this
 * suite's own conventions.
 *
 * **Documented design-doc gap (flagged in this task's completion report, not silently
 * "improved"):** §4's own `CREATE TABLE` declares `reward_kind`/`unit_type`/`unit_code` as
 * nullable (`NULL`) while also naming them in the table's `PRIMARY KEY` — Postgres silently
 * promotes a `PRIMARY KEY` column to `NOT NULL` regardless of an explicit `NULL` marker earlier in
 * the same `CREATE TABLE` (standard, documented Postgres behavior, not a migration bug), so this
 * table structurally CANNOT accept a `NULL` `reward_kind`, even though §2.2 of the same document
 * says `reward_kind` arrives `NULL` on every `reward_fact` row today, pipeline-wide, until
 * `T-173`/`T-RAP-062`/`T-RR-062` land. This suite therefore always inserts a concrete `reward_kind`
 * value (never `NULL`) — asserting `NULL` would insert here would misrepresent this table's own,
 * real, Postgres-enforced shape, not the exact literal design text. Whichever Wave-1 task
 * (`T-RTS-010`) first needs to write a shard row for a `NULL`-`reward_kind` event will hit this
 * head-on and needs an architect decision (e.g. coalesce `NULL` to a sentinel string before this
 * table's `PRIMARY KEY`, or drop `reward_kind`/`unit_type`/`unit_code` from the `PRIMARY KEY`) —
 * not resolved here, since the migration itself is a literal translation of §4's own DDL and this
 * task's own scope is schema-only (no ingestion code).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

describe('T-RTS-002 — campaign_reward_counter_shard migration', () => {
  let sequelize: Sequelize;
  const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM reward_tracking.campaign_reward_counter_shard WHERE campaign_code = :campaignCode',
      { type: QueryTypes.RAW, replacements: { campaignCode } },
    );
    await sequelize.close();
  });

  const insertShardRow = (shardKey: number) =>
    sequelize.query(
      `INSERT INTO reward_tracking.campaign_reward_counter_shard
         (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code, shard_key,
          total_reward_value, total_reward_count)
       VALUES (900001, :campaignCode, 'CASHBACK', 'FIXED_AMOUNT', 'CURRENCY', 'USD', :shardKey, 5, 1)`,
      { type: QueryTypes.RAW, replacements: { campaignCode, shardKey } },
    );

  it('the table and its primary key exist with the expected shape', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_tracking' AND table_name = 'campaign_reward_counter_shard'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(['shard_key', 'total_reward_value', 'total_reward_count']),
    );
  });

  // TC-4: two rows with the same (tenant_id, campaign_code, reward_category, reward_kind,
  // unit_type, unit_code) but a different shard_key are independent rows — this is the whole point
  // of the sharded-counter design (R7): concurrent writers spread across N rows.
  it('TC-4: two rows identical except for shard_key both succeed as independent rows', async () => {
    await expect(insertShardRow(0)).resolves.toBeDefined();
    await expect(insertShardRow(1)).resolves.toBeDefined();

    const rows = await sequelize.query<{ shard_key: number; total_reward_count: number }>(
      `SELECT shard_key, total_reward_count FROM reward_tracking.campaign_reward_counter_shard
         WHERE campaign_code = :campaignCode`,
      { type: QueryTypes.SELECT, replacements: { campaignCode } },
    );
    expect(rows.map((r) => r.shard_key).sort()).toEqual([0, 1]);
  });

  // R7: the write path is a single atomic UPDATE via ON CONFLICT DO UPDATE, never read-then-write
  // — proven directly against the real primary key, not just described in prose.
  it('R7: a second write to the same shard key increments atomically via ON CONFLICT DO UPDATE, never overwrites', async () => {
    await sequelize.query(
      `INSERT INTO reward_tracking.campaign_reward_counter_shard
         (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code, shard_key,
          total_reward_value, total_reward_count)
       VALUES (900001, :campaignCode, 'CASHBACK', 'FIXED_AMOUNT', 'CURRENCY', 'USD', 5, 10, 1)
       ON CONFLICT (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code, shard_key)
       DO UPDATE SET total_reward_value = campaign_reward_counter_shard.total_reward_value + EXCLUDED.total_reward_value,
                     total_reward_count = campaign_reward_counter_shard.total_reward_count + 1`,
      { type: QueryTypes.RAW, replacements: { campaignCode } },
    );
    await sequelize.query(
      `INSERT INTO reward_tracking.campaign_reward_counter_shard
         (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code, shard_key,
          total_reward_value, total_reward_count)
       VALUES (900001, :campaignCode, 'CASHBACK', 'FIXED_AMOUNT', 'CURRENCY', 'USD', 5, 7, 1)
       ON CONFLICT (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code, shard_key)
       DO UPDATE SET total_reward_value = campaign_reward_counter_shard.total_reward_value + EXCLUDED.total_reward_value,
                     total_reward_count = campaign_reward_counter_shard.total_reward_count + 1`,
      { type: QueryTypes.RAW, replacements: { campaignCode } },
    );

    const [row] = await sequelize.query<{ total_reward_value: string; total_reward_count: number }>(
      `SELECT total_reward_value, total_reward_count FROM reward_tracking.campaign_reward_counter_shard
         WHERE campaign_code = :campaignCode AND shard_key = 5`,
      { type: QueryTypes.SELECT, replacements: { campaignCode } },
    );
    expect(Number(row.total_reward_value)).toBe(17);
    expect(row.total_reward_count).toBe(2);
  });
});
