/**
 * T-INT-007 regression suite for
 * `024_add_reward_tracking_dispatch_outbox_reward_entry_id_index.ts`. Runs against the real
 * Postgres 16 server documented in root `CLAUDE.md` — the AGENT-PROTOCOL.md §4 gate (`db:migrate
 * && db:rollback && db:migrate`) is run separately as its own bash step (TC-2) and is what actually
 * proves the migration applies/rolls back/re-applies cleanly; this suite assumes the schema is
 * already migrated (as it is by the time `npm test`/the dedicated jest invocation in the task's own
 * Verification steps runs) and asserts the real, Postgres-enforced property the migration exists to
 * fix (TC-1): the planner uses the new index for the exact RI-check-shaped query Postgres's own FK
 * trigger issues per deleted parent row, instead of falling back to a `Seq Scan`
 * (reward-service-integration-plan/AGENT-PROTOCOL.md §3, "assert the observable property, not the
 * implementation string" — the outcome an index either does or doesn't fix, not a literal string
 * match on `ix_rtdo_reward_entry_id`).
 *
 * TC-1's fixture must be genuinely selective for this to test anything real: seeding 15,000 outbox
 * rows that all reference the *same* one parent row (100% selectivity for that parent's own id) is
 * exactly the scenario where Postgres's own planner correctly prefers a Seq Scan regardless of
 * whether an index exists — proven by hand while building this suite (a first attempt at this
 * fixture did exactly that and failed the way a genuinely missing index would, for the wrong
 * reason). Seeding many *distinct* noise parents (and one outbox row per noise parent) alongside a
 * single target parent, then querying only for the target's id, reproduces the real
 * one-row-out-of-many selectivity the actual FK cascade-check query has in production.
 *
 * `planUsesIndex`/`planHasSeqScan` are duplicated in minimal form from
 * `reward-redemption-entry.migration.spec.ts` per the task file's own instruction ("do not reinvent
 * it, import or duplicate minimally") — there is no shared test-utils module either suite already
 * imports from, so a tiny local duplicate is the minimal option rather than introducing a new shared
 * module for two call sites.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { createMigrator } from '@/database/umzug';

const TENANT_ID = 900_000 + Math.floor(Math.random() * 99_999);

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Total Cost': number;
  Plans?: PlanNode[];
}

function planUsesIndex(node: PlanNode, indexName: string): boolean {
  if (node['Index Name'] === indexName) {
    return true;
  }
  return (node.Plans ?? []).some((child) => planUsesIndex(child, indexName));
}

function planHasSeqScan(node: PlanNode): boolean {
  if (node['Node Type'] === 'Seq Scan') {
    return true;
  }
  return (node.Plans ?? []).some((child) => planHasSeqScan(child));
}

describe('T-INT-007 — reward_tracking_dispatch_outbox.reward_entry_id index', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    // Delete children before parents regardless of whether the test body's own cleanup ran (it
    // won't, if an earlier assertion in this suite ever fails) — a plain `DELETE` on the parent
    // table raises a real FK violation, not a silent no-op, if a child row is still outstanding.
    await sequelize.query(
      `DELETE FROM reward_redemption.reward_tracking_dispatch_outbox
         WHERE reward_entry_id IN (
           SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id
         )`,
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.close();
  });

  // Bash-proven separately too (Verification step 1: db:migrate && db:rollback && db:migrate) —
  // exercised here as well so this same migrator code path is asserted from within the suite.
  it('running the migrator against an already-migrated DB resolves without error', async () => {
    const migrator = createMigrator(sequelize);
    await expect(migrator.up()).resolves.toBeDefined();
  });

  it('the new index exists on reward_tracking_dispatch_outbox', async () => {
    const indexes = await sequelize.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'reward_redemption' AND tablename = 'reward_tracking_dispatch_outbox'`,
      { type: QueryTypes.SELECT },
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(['reward_tracking_dispatch_outbox_pkey', 'ix_rtdo_reward_entry_id']),
    );
  });

  // TC-1: the exact RI-check-shaped query Postgres's own FK trigger issues per deleted parent row
  // (`01-DATABASE.md` §7 / this migration's own header) must use the new index, not a sequential
  // scan, once the table holds a realistic volume of rows and the lookup is genuinely selective
  // (one target parent among ~15,000 distinct parents, one outbox row per parent).
  it('TC-1: EXPLAIN on the RI-check-shaped query uses ix_rtdo_reward_entry_id, not a sequential scan', async () => {
    const parentColumns = `id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
        customer_id_type, activity_performed_date, activity_type, activity_category, activity_value,
        activity_value_unit, channel, activity_performed_env, activity_name, campaign_code,
        tracker_code, tracker_component_code, reward_code, reward_category, reward_value,
        reward_value_unit, reward_entry_date, reward_processed_env, ingestion_channel, status`;

    const [{ id: targetId }] = await sequelize.query<{ id: string }>(
      `INSERT INTO reward_redemption.reward_redemption_entry (${parentColumns})
       VALUES
         (:id, :correlation_id, :tenant_id, 'ciphertext-placeholder', :customer_id_hash, 'EMAIL',
          now(), 'PURCHASE', 'SPEND', 10, 'USD', 'WEB', 'PROD', 't-int-007 target parent', 'CAMP1',
          'TRK1', 'COMP1', 'RWD1', 'CASHBACK', 5, 'USD', now(), 'development', 'REST', 'completed')
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          id: randomUUID(),
          correlation_id: randomUUID(),
          tenant_id: TENANT_ID,
          customer_id_hash: `hash-${randomUUID()}`,
        },
      },
    );

    // 14,999 distinct noise parents + the 1 target above = 15,000 total, each with exactly one
    // outbox row of its own — makes the target lookup below ~1-in-15,000 selective, the real
    // shape of the production FK cascade-check query.
    await sequelize.query(
      `WITH noise_parents AS (
         INSERT INTO reward_redemption.reward_redemption_entry (${parentColumns})
         SELECT gen_random_uuid(), gen_random_uuid(), :tenant_id, 'ciphertext-placeholder',
                'hash-' || g, 'EMAIL', now(), 'PURCHASE', 'SPEND', 10, 'USD', 'WEB', 'PROD',
                't-int-007 noise parent', 'CAMP1', 'TRK1', 'COMP1', 'RWD1', 'CASHBACK', 5, 'USD',
                now(), 'development', 'REST', 'completed'
         FROM generate_series(1, 14999) g
         RETURNING id
       )
       INSERT INTO reward_redemption.reward_tracking_dispatch_outbox
         (id, reward_entry_id, topic, payload, status)
       SELECT gen_random_uuid(), id, 'reward.redemption.completed.v1',
              jsonb_build_object('seed', 'noise'), 'DISPATCHED'
       FROM noise_parents`,
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      `INSERT INTO reward_redemption.reward_tracking_dispatch_outbox
         (id, reward_entry_id, topic, payload, status)
       VALUES (:id, :target_id, 'reward.redemption.completed.v1', :payload, 'DISPATCHED')`,
      {
        type: QueryTypes.RAW,
        replacements: {
          id: randomUUID(),
          target_id: targetId,
          payload: JSON.stringify({ seed: 'target' }),
        },
      },
    );
    await sequelize.query('ANALYZE reward_redemption.reward_tracking_dispatch_outbox;', {
      type: QueryTypes.RAW,
    });

    const [explainRow] = await sequelize.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (FORMAT JSON)
       SELECT 1 FROM reward_redemption.reward_tracking_dispatch_outbox
       WHERE reward_entry_id = :target_id
       FOR KEY SHARE`,
      { type: QueryTypes.SELECT, replacements: { target_id: targetId } },
    );
    const plan = explainRow['QUERY PLAN'][0].Plan;

    expect(planUsesIndex(plan, 'ix_rtdo_reward_entry_id')).toBe(true);
    expect(planHasSeqScan(plan)).toBe(false);
  });
});
