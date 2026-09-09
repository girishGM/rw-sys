/**
 * T-RTS-047 regression suite for `src/database/cli/seed.ts` +
 * `src/database/seeds/seed-data.constants.ts` — the fixture `T-RTS-045`'s own TC-2 needs.
 *
 * Runs against the real Postgres 16 server (`schema-and-role.migration.spec.ts`'s own convention —
 * assumes the schema is already migrated, as it is by the time `npm test` runs in the completion-
 * report verification sequence). Deliberately invokes the real `npm run db:seed` CLI via
 * `child_process` (TC-1/TC-2/TC-3 all need to prove the *actual, observable* command a Render
 * operator will run, not just an internal function — `AGENT-PROTOCOL.md` §3: "assert the observable
 * property, not the implementation string") rather than importing `main()` directly — `cli/seed.ts`
 * has no exported entry point, by the same one-shot-script convention `cli/migrate.ts` already uses.
 *
 * **TC-3, the regression test that matters.** `expect(...).not.toThrow()` alone would pass whether
 * or not the seed script actually reproduces doc 03 — this suite instead re-reads every derived row
 * this task's own DoD requires (doc 03 §2/§4/§6) and asserts the exact values, so reverting
 * `seed-data.constants.ts`'s pre-computed `reward_entry_id` values (breaking the shard formula this
 * file's header documents) or breaking any upsert's `ON CONFLICT` target would fail this suite. This
 * was proven by temporarily reverting `SEED-T-RTS-047-E1-6`'s own suffix (breaking its shard
 * assignment) and re-running this file — the shard-row assertion below failed exactly as expected;
 * reverted back to the correct value before this report.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  SEED_CAMPAIGN_CODE,
  SEED_REWARD_TRACKING_EVENTS,
  SEED_EXPECTED_LEDGER_ROWS,
  SEED_EXPECTED_SHARD_ROWS,
  SEED_EXPECTED_EXPIRING_BALANCE_ROWS,
} from '@/database/seeds/seed-data.constants';

const SERVICE_ROOT = path.join(__dirname, '..', '..');

function runSeedCli(): string {
  return execFileSync(
    'npx',
    ['ts-node', '-T', '-r', 'tsconfig-paths/register', 'src/database/cli/seed.ts'],
    { cwd: SERVICE_ROOT, encoding: 'utf8', env: process.env },
  );
}

describe('T-RTS-047 — db:seed reproduces brain-storm/03-ACCUMULATION-EXAMPLES.md', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('TC-2/TC-3: seeding (idempotently) produces the exact doc 03 §1 reward_fact rows', () => {
    // First run: applies every event (or reports already-applied on a re-run of this same suite).
    const firstRun = runSeedCli();
    expect(firstRun).toContain('Verified');

    // Second run: every reward_entry_id already exists — must skip all five, never double-write
    // (R3/R11), and must still pass its own byte-for-byte verification.
    const secondRun = runSeedCli();
    expect(secondRun).toContain('already seeded');
    expect(secondRun).toContain('Verified');
  }, 60_000);

  it('reward_fact carries exactly the five doc 03 §1 events, verbatim', async () => {
    const rows = await sequelize.query<{
      reward_entry_id: string;
      customer_id_hash: string;
      reward_category: string;
      reward_kind: string;
      reward_value: string;
      expires_at: string | null;
    }>(
      `SELECT reward_entry_id, customer_id_hash, reward_category, reward_kind, reward_value, expires_at
         FROM reward_tracking.reward_fact
        WHERE campaign_code = :campaignCode
        ORDER BY redeemed_at`,
      { type: QueryTypes.SELECT, replacements: { campaignCode: SEED_CAMPAIGN_CODE } },
    );

    expect(rows).toHaveLength(SEED_REWARD_TRACKING_EVENTS.length);
    SEED_REWARD_TRACKING_EVENTS.forEach((event, index) => {
      const row = rows[index]!;
      expect(row.reward_entry_id).toBe(event.rewardEntryId);
      expect(row.customer_id_hash).toBe(event.customerIdHash);
      expect(row.reward_category).toBe(event.rewardCategory);
      expect(row.reward_kind).toBe(event.rewardKind);
      expect(Number(row.reward_value)).toBe(Number(event.rewardValue));
      if (event.expiresAt === null) {
        expect(row.expires_at).toBeNull();
      } else {
        expect(new Date(row.expires_at as string).toISOString()).toBe(event.expiresAt);
      }
    });
  });

  it('customer_reward_ledger matches doc 03 §2 exactly (four rows, events #1/#4 merged)', async () => {
    const rows = await sequelize.query<{
      customer_id_hash: string;
      tracker_code: string;
      reward_category: string;
      reward_kind: string;
      total_reward_value: string;
      total_reward_count: number;
    }>(
      `SELECT customer_id_hash, tracker_code, reward_category, reward_kind, total_reward_value,
              total_reward_count
         FROM reward_tracking.customer_reward_ledger
        WHERE campaign_code = :campaignCode`,
      { type: QueryTypes.SELECT, replacements: { campaignCode: SEED_CAMPAIGN_CODE } },
    );

    expect(rows).toHaveLength(SEED_EXPECTED_LEDGER_ROWS.length);
    for (const expected of SEED_EXPECTED_LEDGER_ROWS) {
      const actual = rows.find(
        (row) =>
          row.customer_id_hash === expected.customerIdHash &&
          row.tracker_code === expected.trackerCode &&
          row.reward_category === expected.rewardCategory &&
          row.reward_kind === expected.rewardKind,
      );
      expect(actual).toBeDefined();
      expect(Number(actual!.total_reward_value)).toBe(Number(expected.totalRewardValue));
      expect(actual!.total_reward_count).toBe(expected.totalRewardCount);
    }
  });

  it('campaign_reward_counter_shard matches doc 03 §4 exactly (five independent shard rows)', async () => {
    const rows = await sequelize.query<{
      reward_category: string;
      reward_kind: string;
      shard_key: number;
      total_reward_value: string;
      total_reward_count: number;
    }>(
      `SELECT reward_category, reward_kind, shard_key, total_reward_value, total_reward_count
         FROM reward_tracking.campaign_reward_counter_shard
        WHERE campaign_code = :campaignCode`,
      { type: QueryTypes.SELECT, replacements: { campaignCode: SEED_CAMPAIGN_CODE } },
    );

    expect(rows).toHaveLength(SEED_EXPECTED_SHARD_ROWS.length);
    for (const expected of SEED_EXPECTED_SHARD_ROWS) {
      const actual = rows.find(
        (row) =>
          row.reward_category === expected.rewardCategory &&
          row.reward_kind === expected.rewardKind &&
          row.shard_key === expected.shardKey,
      );
      expect(actual).toBeDefined();
      expect(Number(actual!.total_reward_value)).toBe(Number(expected.totalRewardValue));
      expect(actual!.total_reward_count).toBe(expected.totalRewardCount);
    }
  });

  it("customer_reward_balance surfaces exactly doc 03 §6's two expiring rows for cust-hash-A", async () => {
    const rows = await sequelize.query<{
      reward_category: string;
      reward_kind: string;
      issued_value: string;
      expires_at: string;
    }>(
      `SELECT reward_category, reward_kind, issued_value, expires_at
         FROM reward_tracking.customer_reward_balance
        WHERE tenant_id = 1 AND customer_id_hash = 'cust-hash-A'
          AND status = 'ACTIVE' AND expires_at < now() + interval '90 days'`,
      { type: QueryTypes.SELECT },
    );

    expect(rows).toHaveLength(SEED_EXPECTED_EXPIRING_BALANCE_ROWS.length);
    for (const expected of SEED_EXPECTED_EXPIRING_BALANCE_ROWS) {
      const actual = rows.find(
        (row) =>
          row.reward_category === expected.rewardCategory &&
          row.reward_kind === expected.rewardKind,
      );
      expect(actual).toBeDefined();
      expect(Number(actual!.issued_value)).toBe(Number(expected.issuedValue));
      expect(new Date(actual!.expires_at).toISOString()).toBe(expected.expiresAt);
    }
  });

  // TC-4: adjacent behaviour (the ordinary migration round trip) is unaffected by this table now
  // having seeded rows in it — proven by the bash gate (`db:migrate && db:rollback && db:migrate`)
  // run separately as part of this task's own completion report, not re-proven here.
});
