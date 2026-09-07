/**
 * T-RR-010 — `RewardRedemptionEntryRepository`, exercised against the real Postgres 16 server
 * (root `CLAUDE.md`), never a mock/in-memory DB — same real-DB convention
 * `RewardRedemptionEntryClaimRepository`'s own spec (T-RR-020) already established for this same
 * table's sibling repository.
 *
 * Every test scopes its own rows by a random `tenant_id`, cleaned up in `afterAll` — this table is
 * shared with other test files/sibling agents (see that spec's own file header on the tradeoff),
 * but nothing here depends on the table being otherwise empty.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  RewardRedemptionEntryRepository,
  type NewRewardRedemptionEntryInput,
} from '@/modules/reward-ingestion/reward-redemption-entry.repository';
import type { Config } from '@/config/config.schema';

const TENANT_ID = 930_000 + Math.floor(Math.random() * 9_999);

function baseInput(
  overrides: Partial<NewRewardRedemptionEntryInput> = {},
): NewRewardRedemptionEntryInput {
  return {
    id: randomUUID(),
    correlation_id: randomUUID(),
    tenant_id: TENANT_ID,
    customer_id_encrypted: 'ciphertext-placeholder',
    customer_id_hash: `hash-${randomUUID()}`,
    customer_id_type: 'EMAIL',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'ACT_CODE',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: '10.0000',
    activity_value_unit: 'USD',
    channel: 'app',
    activity_performed_env: 'production',
    activity_name: 't-rr-010 repository fixture',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'CASHBACK',
    reward_value: '5.0000',
    reward_value_unit: 'USD',
    reward_entry_date: new Date(),
    completion_cycle: 1,
    reward_processed_env: 'development',
    ingestion_channel: 'REST',
    ...overrides,
  };
}

/** Same substitution idiom as `reward-redemption-entry-claim.repository.spec.ts`'s own
 * `realDbConfigService()` — reads the real `.env.development` values already loaded by
 * `test/database/env.setup.ts`. */
function realDbConfigService(): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
  } as Partial<Config>;
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

describe('T-RR-010 — RewardRedemptionEntryRepository', () => {
  let migrationDb: Sequelize;
  let repository: RewardRedemptionEntryRepository;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    repository = new RewardRedemptionEntryRepository(realDbConfigService());
  });

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
    await repository.onModuleDestroy();
  });

  it('TC-1: inserts a fresh row — wasInserted true, status defaults to received, given fields persisted verbatim', async () => {
    const input = baseInput();

    const result = await repository.insertOrGetExisting(input);

    expect(result.wasInserted).toBe(true);
    expect(result.row.id).toBe(input.id);
    expect(result.row.status).toBe('received');
    expect(result.row.customer_id_encrypted).toBe(input.customer_id_encrypted);
    expect(result.row.customer_id_hash).toBe(input.customer_id_hash);
    expect(result.row.ingestion_channel).toBe('REST');
  });

  it('TC-2: a second insert of the same id never creates a second row, and the original row is untouched', async () => {
    const input = baseInput();
    const first = await repository.insertOrGetExisting(input);
    expect(first.wasInserted).toBe(true);

    const second = await repository.insertOrGetExisting(
      baseInput({ id: input.id, activity_name: 'a-different-value-that-must-be-ignored' }),
    );

    expect(second.wasInserted).toBe(false);
    expect(second.row.id).toBe(input.id);
    // The original row's own value wins — the second call's differing field is never applied.
    expect(second.row.activity_name).toBe(input.activity_name);

    const countResult = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: input.id } },
    );
    expect(countResult[0].count).toBe('1');
  });

  it('TC-4: a duplicate id whose row already reached a terminal status reports that status, not `received`', async () => {
    const input = baseInput();
    await repository.insertOrGetExisting(input);
    await migrationDb.query(
      `UPDATE reward_redemption.reward_redemption_entry SET status = 'completed', redeemed_at = now()
       WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id: input.id } },
    );

    const result = await repository.insertOrGetExisting(baseInput({ id: input.id }));

    expect(result.wasInserted).toBe(false);
    expect(result.row.status).toBe('completed');
  });

  it('TC-3 (concurrency): two real concurrent inserts of the same id — exactly one row ever exists, neither call throws', async () => {
    const id = randomUUID();

    const [first, second] = await Promise.all([
      repository.insertOrGetExisting(baseInput({ id })),
      repository.insertOrGetExisting(baseInput({ id })),
    ]);

    // Exactly one of the two calls actually inserted; the other short-circuited.
    expect([first.wasInserted, second.wasInserted].sort()).toEqual([false, true]);
    const winner = first.wasInserted ? first : second;
    const loser = first.wasInserted ? second : first;
    // The winner's own `RETURNING *` is part of the same atomic `INSERT`, so it always observes
    // the row exactly as freshly created. The loser's own follow-up `SELECT` runs a moment later
    // and, on this shared, un-tenant-scoped table (this file's own header), can legitimately
    // observe the row having already been claimed by T-RR-020's own real `ClaimWorkerService`
    // integration test running concurrently in a different Jest worker (its claim query is
    // deliberately global, not scoped to any one test's rows) — a real, already-documented
    // tradeoff of this shared table, not a defect in this repository's own conflict handling. The
    // property this task actually owns (exactly one row, no duplicate insert, no throw) holds
    // regardless of which valid status the loser observes.
    expect(winner.row.status).toBe('received');
    expect(['received', 'processing']).toContain(loser.row.status);

    const countResult = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(countResult[0].count).toBe('1');
  });
});
