/**
 * T-RR-036 — `NotificationLogRepository`, exercised against the real Postgres 16 server (root
 * `CLAUDE.md`), connected as the real least-privilege `rr_app` role — same real-DB convention
 * every other repository spec in this service already establishes (T-RR-006/T-RR-020/T-RR-033/
 * T-RR-034).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import { NotificationLogRepository } from '@/modules/notification/notification-log.repository';
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

describe('T-RR-036 — NotificationLogRepository', () => {
  let migrationDb: Sequelize;
  let appPool: Pool;
  let repository: NotificationLogRepository;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    appPool = newAppPool();
    repository = new NotificationLogRepository(realDbConfigService(), appPool);
  });

  afterAll(async () => {
    await migrationDb.query(
      `DELETE FROM reward_redemption.notification_log
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

  function buildRow(entryId: string, overrides: Record<string, unknown> = {}) {
    return {
      rewardEntryId: entryId,
      tenantId: TENANT_ID,
      customerIdHash: `hash-${randomUUID()}`,
      campaignCode: 'CAMP1',
      rewardCode: 'RWD1',
      channel: 'PUSH' as const,
      wouldBePayload: { channel: 'PUSH', note: 'T-RR-036 fixture payload' },
      ...overrides,
    };
  }

  describe('create (standalone, no caller-supplied client)', () => {
    it('TC-1: writes a notification_log row using this repository’s own pool', async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID);

      const inserted = await repository.create(buildRow(entry.id));

      expect(inserted.reward_entry_id).toBe(entry.id);
      expect(inserted.channel).toBe('PUSH');
      expect(inserted.customer_id_hash).toMatch(/^hash-/);

      const [persisted] = await migrationDb.query<{ id: string; reward_entry_id: string }>(
        'SELECT id, reward_entry_id FROM reward_redemption.notification_log WHERE id = :id',
        { type: QueryTypes.SELECT, replacements: { id: inserted.id } },
      );
      expect(persisted).toBeDefined();
      expect(persisted.reward_entry_id).toBe(entry.id);
    });

    // TC-4/R8.
    it('TC-4: persists customer_id_hash only — no customer_id_encrypted/plaintext column exists on this table', async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID);

      const inserted = await repository.create(buildRow(entry.id));

      expect(inserted).not.toHaveProperty('customer_id_encrypted');
      expect(Object.keys(inserted)).not.toContain('customerId');
    });

    // TC-5.
    it("TC-5: channel is always persisted as 'PUSH'", async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID);

      const inserted = await repository.create(buildRow(entry.id));

      expect(inserted.channel).toBe('PUSH');
    });

    // TC-8.
    it('TC-8: two rows for the same customer/tenant are both persisted independently, no dedup/merge', async () => {
      const first = await insertEntry(migrationDb, TENANT_ID);
      const second = await insertEntry(migrationDb, TENANT_ID);
      const sharedHash = `hash-${randomUUID()}`;

      const insertedFirst = await repository.create(
        buildRow(first.id, { customerIdHash: sharedHash }),
      );
      const insertedSecond = await repository.create(
        buildRow(second.id, { customerIdHash: sharedHash }),
      );

      expect(insertedFirst.id).not.toBe(insertedSecond.id);

      const rows = await migrationDb.query<{ id: string }>(
        'SELECT id FROM reward_redemption.notification_log WHERE customer_id_hash = :hash',
        { type: QueryTypes.SELECT, replacements: { hash: sharedHash } },
      );
      expect(rows).toHaveLength(2);
    });
  });

  describe('create (caller-supplied transaction handle)', () => {
    // TC-7.
    it('TC-7: participates in the caller-supplied transaction — a commit persists the row', async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID);
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await repository.create(buildRow(entry.id), client);
        await client.query('COMMIT');

        expect(inserted.reward_entry_id).toBe(entry.id);
      } finally {
        client.release();
      }

      const rows = await migrationDb.query(
        'SELECT id FROM reward_redemption.notification_log WHERE reward_entry_id = :id',
        { type: QueryTypes.SELECT, replacements: { id: entry.id } },
      );
      expect(rows).toHaveLength(1);
    });

    it('TC-7: a rolled-back caller transaction leaves no notification_log row behind', async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID);
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await repository.create(buildRow(entry.id), client);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const rows = await migrationDb.query(
        'SELECT id FROM reward_redemption.notification_log WHERE reward_entry_id = :id',
        { type: QueryTypes.SELECT, replacements: { id: entry.id } },
      );
      expect(rows).toHaveLength(0);
    });
  });
});
