/**
 * T-RR-035 — `RewardTrackingDispatchRetryRepository`, exercised against the real Postgres 16
 * server (root `CLAUDE.md`), connected as the real least-privilege `rr_app` role — same real-DB
 * convention every other repository spec in this service already establishes
 * (T-RR-006/T-RR-020/T-RR-033/T-RR-034).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import { RewardTrackingDispatchRetryRepository } from '@/modules/dispatch/reward-tracking-dispatch-retry.repository';
import { buildOutboxPayload } from '@/modules/dispatch/reward-tracking-outbox.repository';
import type { Config } from '@/config/config.schema';
import { insertEntry } from './fixtures/reward-redemption-entry.fixture';

const TENANT_ID = 940_000 + Math.floor(Math.random() * 49_999);

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

function newAppPool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
  });
}

describe('T-RR-035 — RewardTrackingDispatchRetryRepository', () => {
  let migrationDb: Sequelize;
  let appPool: Pool;
  let repository: RewardTrackingDispatchRetryRepository;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    appPool = newAppPool();
    repository = new RewardTrackingDispatchRetryRepository(realDbConfigService(), appPool);
  });

  afterAll(async () => {
    await migrationDb.query(
      `DELETE FROM reward_redemption.reward_tracking_dispatch_retry
         WHERE reward_entry_id IN (
           SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id
         )`,
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
    await repository.onModuleDestroy();
  });

  it('TC-5: create() writes a pending row, attempts = 0, next_attempt_at immediately due', async () => {
    const entry = await insertEntry(migrationDb, TENANT_ID);
    const payload = buildOutboxPayload(entry);

    const inserted = await repository.create({
      rewardEntryId: entry.id,
      payload,
      lastError: 'both dispatch tiers exhausted',
    });

    expect(inserted.status).toBe('pending');
    expect(inserted.attempts).toBe(0);
    expect(inserted.reward_entry_id).toBe(entry.id);
    expect(new Date(inserted.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('TC-6/TC-7: findDueBatch only returns pending rows whose next_attempt_at has elapsed, joined to the entry scope fields', async () => {
    const entry = await insertEntry(migrationDb, TENANT_ID, {
      reward_code: `RWD_${randomUUID().slice(0, 8)}`,
      tracker_code: `TRK_${randomUUID().slice(0, 8)}`,
      campaign_code: `CAMP_${randomUUID().slice(0, 8)}`,
    });
    const payload = buildOutboxPayload(entry);
    const due = await repository.create({ rewardEntryId: entry.id, payload, lastError: 'x' });

    const notDueEntry = await insertEntry(migrationDb, TENANT_ID);
    const notDuePayload = buildOutboxPayload(notDueEntry);
    const notDue = await repository.create({
      rewardEntryId: notDueEntry.id,
      payload: notDuePayload,
      lastError: 'x',
    });
    await migrationDb.query(
      `UPDATE reward_redemption.reward_tracking_dispatch_retry
          SET next_attempt_at = now() + interval '1 hour'
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id: notDue.id } },
    );

    const dueRows = await repository.findDueBatch(200);

    expect(dueRows.some((r) => r.id === due.id)).toBe(true);
    expect(dueRows.some((r) => r.id === notDue.id)).toBe(false);
    const dueRow = dueRows.find((r) => r.id === due.id);
    expect(dueRow?.rewardCode).toBe(entry.reward_code);
    expect(dueRow?.trackerCode).toBe(entry.tracker_code);
    expect(dueRow?.campaignCode).toBe(entry.campaign_code);
    expect(dueRow?.tenantId).toBe(entry.tenant_id);
    expect(dueRow?.payload.rewardEntryId).toBe(entry.id);
  });

  it('TC-8: recordAttemptFailure increments attempts, updates last_error/next_attempt_at, stays pending', async () => {
    const entry = await insertEntry(migrationDb, TENANT_ID);
    const payload = buildOutboxPayload(entry);
    const row = await repository.create({ rewardEntryId: entry.id, payload, lastError: 'x' });
    const nextAttemptAt = new Date(Date.now() + 60_000);

    await repository.recordAttemptFailure(row.id, 'kafka: down; rest: down', nextAttemptAt);

    const [persisted] = await migrationDb.query<{
      attempts: number;
      status: string;
      last_error: string;
      next_attempt_at: Date;
    }>(
      'SELECT attempts, status, last_error, next_attempt_at FROM reward_redemption.reward_tracking_dispatch_retry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: row.id } },
    );
    expect(persisted.attempts).toBe(1);
    expect(persisted.status).toBe('pending');
    expect(persisted.last_error).toBe('kafka: down; rest: down');
    expect(new Date(persisted.next_attempt_at).getTime()).toBeCloseTo(nextAttemptAt.getTime(), -2);
  });

  it('TC-8: markExhausted flips status to exhausted, excluding it from later findDueBatch calls', async () => {
    const entry = await insertEntry(migrationDb, TENANT_ID);
    const payload = buildOutboxPayload(entry);
    const row = await repository.create({ rewardEntryId: entry.id, payload, lastError: 'x' });

    await repository.markExhausted(row.id, 'exhausted after 5 attempts');

    const [persisted] = await migrationDb.query<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM reward_redemption.reward_tracking_dispatch_retry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: row.id } },
    );
    expect(persisted.status).toBe('exhausted');
    expect(persisted.last_error).toBe('exhausted after 5 attempts');

    const dueRows = await repository.findDueBatch(200);
    expect(dueRows.some((r) => r.id === row.id)).toBe(false);
  });

  it('TC-7: markDelivered deletes the row outright (no third status value)', async () => {
    const entry = await insertEntry(migrationDb, TENANT_ID);
    const payload = buildOutboxPayload(entry);
    const row = await repository.create({ rewardEntryId: entry.id, payload, lastError: 'x' });

    await repository.markDelivered(row.id);

    const rows = await migrationDb.query(
      'SELECT id FROM reward_redemption.reward_tracking_dispatch_retry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: row.id } },
    );
    expect(rows).toHaveLength(0);
  });
});
