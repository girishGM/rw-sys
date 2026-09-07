/**
 * T-RR-063 — `RedemptionStateMachineService`'s new `expires_at` column write, exercised against
 * the real Postgres 16 server (root `CLAUDE.md`), same convention as
 * `redemption-state-machine.service.spec.ts` (T-RR-021, not edited by this task): each test seeds
 * its own row by known `id` and only ever touches that row.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { createMigrationConnection } from '@/database/migration-connection';
import { RedemptionStateMachineService } from '@/modules/redemption/redemption-state-machine.service';
import type { RedemptionCompletionSideEffectsPort } from '@/modules/redemption/redemption-completion-side-effects.port';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

const TENANT_ID = 963_000 + Math.floor(Math.random() * 36_999);

function baseEntryFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    activity_value: 10,
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 't-rr-063 expiry fixture',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'CASHBACK',
    reward_value: 5,
    reward_value_unit: 'USD',
    reward_entry_date: new Date(),
    completion_cycle: 1,
    reward_processed_env: 'development',
    ingestion_channel: 'REST',
    status: 'processing',
    retry_count: 0,
    next_attempt_at: null,
    ...overrides,
  };
}

async function insertEntry(
  sequelize: Sequelize,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const f = baseEntryFields(overrides);
  const [row] = await sequelize.query<{ id: string }>(
    `INSERT INTO reward_redemption.reward_redemption_entry
       (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
        activity_performed_date, transaction_type, activity_code, activity_type,
        activity_category, activity_value, activity_value_unit, channel, activity_performed_env,
        activity_name, campaign_code, tracker_code, tracker_component_code, merchant_code,
        reward_code, reward_category, reward_value, reward_value_unit, reward_entry_date,
        completion_cycle, reward_processed_env, ingestion_channel, status, retry_count,
        next_attempt_at)
     VALUES
       (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
        :customer_id_type, :activity_performed_date, :transaction_type, :activity_code,
        :activity_type, :activity_category, :activity_value, :activity_value_unit, :channel,
        :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
        :tracker_component_code, :merchant_code, :reward_code, :reward_category, :reward_value,
        :reward_value_unit, :reward_entry_date, :completion_cycle, :reward_processed_env,
        :ingestion_channel, :status, :retry_count, :next_attempt_at)
     RETURNING id`,
    { type: QueryTypes.SELECT, replacements: f },
  );
  return row.id;
}

async function fetchRow(sequelize: Sequelize, id: string): Promise<RewardRedemptionEntryRow> {
  const [row] = await sequelize.query<RewardRedemptionEntryRow>(
    'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = :id',
    { type: QueryTypes.SELECT, replacements: { id } },
  );
  return row;
}

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

function fakeSideEffects(): RedemptionCompletionSideEffectsPort {
  return {
    async recordCompletionSideEffects() {
      /* not exercised by this file */
    },
  };
}

describe('T-RR-063 — RedemptionStateMachineService writes expires_at', () => {
  let migrationDb: Sequelize;
  let service: RedemptionStateMachineService;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
  });

  beforeEach(() => {
    service = new RedemptionStateMachineService(realDbConfigService(), fakeSideEffects());
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
  });

  // TC-4/TC-5 (markDispatchedExternal side).
  it('TC-4: a BoundReward with no expiry (expiresAt undefined) leaves expires_at NULL after markDispatchedExternal', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });

    const updated = await service.markDispatchedExternal({
      entryId: id,
      externalSystemCode: 'PROMO_CODE_SERVICE',
      externalReferenceId: 'promo-code-no-expiry',
    });

    expect(updated.expires_at).toBeNull();
    const persisted = await fetchRow(migrationDb, id);
    expect(persisted.expires_at).toBeNull();
  });

  it('TC-5: a resolved expiry duration -> expires_at = redeemed_at + duration (markDispatchedExternal), same instant both fields are anchored to', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });
    const nowUtc = new Date();
    const expiresAt = new Date(nowUtc.getTime() + 5 * 3_600_000); // 5 hours

    const updated = await service.markDispatchedExternal({
      entryId: id,
      externalSystemCode: 'PROMO_CODE_SERVICE',
      externalReferenceId: 'promo-code-with-expiry',
      expiresAt,
    });

    expect(updated.redeemed_at).not.toBeNull();
    expect(updated.expires_at).not.toBeNull();
    expect(updated.expires_at!.getTime()).toBe(expiresAt.getTime());
    // Both fields were written by the same statement/transaction, from instants captured within
    // milliseconds of each other -- assert they are consistent with each other, not just present.
    const diffMs = updated.expires_at!.getTime() - updated.redeemed_at!.getTime();
    expect(diffMs).toBeGreaterThanOrEqual(5 * 3_600_000 - 5_000);
    expect(diffMs).toBeLessThanOrEqual(5 * 3_600_000 + 5_000);
  });

  // TC-4 (no-connector / markCompletedDirect side).
  it('a BoundReward with no expiry leaves expires_at NULL after markCompletedDirect', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });

    const updated = await service.markCompletedDirect(id, null);

    expect(updated.expires_at).toBeNull();
    const persisted = await fetchRow(migrationDb, id);
    expect(persisted.expires_at).toBeNull();
  });

  it('markCompletedDirect with no expiresAt argument at all (pre-T-RR-063 call shape) still leaves expires_at NULL', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });

    const updated = await service.markCompletedDirect(id);

    expect(updated.expires_at).toBeNull();
  });

  it('a resolved expiry duration -> expires_at = redeemed_at + duration (markCompletedDirect)', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });
    const nowUtc = new Date();
    const expiresAt = new Date(nowUtc.getTime() + 15 * 60_000); // 15 minutes

    const updated = await service.markCompletedDirect(id, expiresAt);

    expect(updated.expires_at).not.toBeNull();
    expect(updated.expires_at!.getTime()).toBe(expiresAt.getTime());
    const diffMs = updated.expires_at!.getTime() - updated.redeemed_at!.getTime();
    expect(diffMs).toBeGreaterThanOrEqual(15 * 60_000 - 5_000);
    expect(diffMs).toBeLessThanOrEqual(15 * 60_000 + 5_000);
  });

  // TC-7 (existing suite unaffected) is covered by the full `npm test -- redemption processing`
  // run in this task's own verification steps, not re-asserted here.
});

/**
 * T-RR-063 DoD / review retry 1: "confirmed this service's own Postgres connection is UTC before
 * relying on `now()` for the shared instant ... rather than assuming it." Uses the exact same
 * connection shape `RedemptionStateMachineService`'s own constructor builds internally (`rr_app`
 * role, `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_SSL` from env, `db/redemption-state-machine.service.ts`)
 * rather than `createMigrationConnection()`'s superuser role — this is the connection whose session
 * timezone actually matters for the `redeemed_at = now()` / `expires_at = $n` statements this task
 * touches.
 */
describe('T-RR-063 — DB session timezone / shared-instant confirmation (review fix)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("confirms (does not assume) whether the session is UTC, and asserts the property computeExpiresAt's callers actually rely on — SQL now() and JS new Date() agree on the same real-world instant regardless", async () => {
    // `SHOW` does not support a column alias (`SHOW timezone AS tz` is a syntax error) — its
    // single result column is always named after the GUC itself, `"TimeZone"`.
    const { rows: tzRows } = await pool.query<{ TimeZone: string }>('SHOW timezone');
    const sessionTimezone = tzRows[0].TimeZone;

    const before = Date.now();
    const { rows: nowRows } = await pool.query<{ db_now: Date }>('SELECT now() AS db_now');
    const after = Date.now();
    const dbNowMs = nowRows[0].db_now.getTime();

    // Root cause (see expiry-computation.ts's own header comment for the full explanation): a
    // `timestamptz` value is always an absolute instant on the wire; the session `TimeZone` GUC
    // only changes the *display offset*, which node-pg's parser already accounts for when building
    // the JS `Date` above. So this assertion holds independent of `sessionTimezone` — including in
    // this project's real local Postgres, where it is genuinely not UTC.
    if (sessionTimezone !== 'UTC') {
      // eslint-disable-next-line no-console -- T-RR-063 DoD: this must be *visible*, not silently
      // passed over, per "confirm this holds -- do not assume" (AGENT-PROTOCOL.md §7 framing).
      console.warn(
        `T-RR-063: this Postgres session's timezone is "${sessionTimezone}", not UTC. Confirmed ` +
          'safe (see expiry-computation.ts) because timestamptz is timezone-agnostic on the wire ' +
          '-- verified empirically by the assertion below, which would fail if that ever stopped ' +
          'being true.',
      );
    }

    // The actual property `computeExpiresAt`'s callers depend on: SQL `now()`, read back through
    // this service's own connection, must land within a couple of seconds of this test process's
    // own `Date.now()` — not "session timezone happens to equal UTC" (which it doesn't, here).
    expect(dbNowMs).toBeGreaterThanOrEqual(before - 2_000);
    expect(dbNowMs).toBeLessThanOrEqual(after + 2_000);
  });
});
