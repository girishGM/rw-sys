/**
 * T-RR-034 — `RewardTrackingOutboxRepository`, exercised against the real Postgres 16 server (root
 * `CLAUDE.md`), connected as the real least-privilege `rr_app` role — same real-DB convention
 * every other repository spec in this service already establishes (T-RR-006/T-RR-020/T-RR-033).
 *
 * **T-RR-070**: `findPendingBatch`'s own `ORDER BY o.created_at ASC LIMIT $1` is genuine,
 * intentional production behaviour (oldest-first fairness across every tenant, T-RR-034's own
 * header) — never scoped to this suite's own `TENANT_ID`, because the real query has no tenant
 * filter at all (`OutboxPublisherService`'s poll cycle drains the whole table). That means a
 * hardcoded small `LIMIT` (`50`/`200`) in a test that asserts *presence* of its own,
 * just-inserted (therefore newest) row is only ever safe on an empty-ish table — on this shared,
 * real dev Postgres instance (root `CLAUDE.md`, one server for the whole plan, no per-suite
 * isolation), other concurrently- or previously-run specs against this same
 * `reward_tracking_dispatch_outbox` table can and do leave hundreds of older `PENDING` rows ahead
 * of this suite's own row in that same ASC ordering, pushing it past any fixed small `LIMIT` —
 * reproduced directly (`T-RR-070`'s own evidence: 1059 real `PENDING` rows observed, causing
 * `findPendingBatch(50)`/`findPendingBatch(200)` to both miss a row inserted moments earlier).
 * `pendingBatchSizeCoveringAll()` below sizes the batch dynamically off the table's own current
 * `PENDING` count instead of guessing a fixed constant — the fix is entirely test-side (this
 * suite's own presence assertions), not a change to `findPendingBatch`'s real, intentional
 * contract.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  RewardTrackingOutboxRepository,
  buildOutboxPayload,
} from '@/modules/dispatch/reward-tracking-outbox.repository';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import { insertEntry } from './fixtures/reward-redemption-entry.fixture';

const TENANT_ID = 950_000 + Math.floor(Math.random() * 49_999);

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

/** T-RR-070: a `LIMIT` guaranteed to cover every currently-`PENDING` row in the real, shared
 * table (see this file's own header) — computed fresh per call rather than hardcoded, since the
 * ambient count is genuinely unbounded on this shared dev instance. `+ 10` is headroom against a
 * handful of rows landing between this count query and the following `findPendingBatch` call. */
async function pendingBatchSizeCoveringAll(migrationDb: Sequelize): Promise<number> {
  const [row] = await migrationDb.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM reward_redemption.reward_tracking_dispatch_outbox WHERE status = 'PENDING'",
    { type: QueryTypes.SELECT },
  );
  return Number(row.count) + 10;
}

describe('T-RR-034 — RewardTrackingOutboxRepository', () => {
  let migrationDb: Sequelize;
  let appPool: Pool;
  let repository: RewardTrackingOutboxRepository;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    appPool = newAppPool();
    repository = new RewardTrackingOutboxRepository(realDbConfigService(), appPool);
  });

  afterAll(async () => {
    await migrationDb.query(
      `DELETE FROM reward_redemption.reward_tracking_dispatch_outbox
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

  describe('buildOutboxPayload', () => {
    it('TC-4: maps every 02-KAFKA-CONTRACTS.md §2 field, camelCase, customerIdEncrypted not customerId', async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID);

      const payload = buildOutboxPayload(entry);

      expect(payload).toEqual({
        rewardEntryId: entry.id,
        tenantId: entry.tenant_id,
        tenantCode: entry.tenant_code,
        countryCode: entry.country_code,
        customerIdEncrypted: entry.customer_id_encrypted,
        campaignCode: entry.campaign_code,
        rewardCode: entry.reward_code,
        rewardCategory: entry.reward_category,
        rewardValue: entry.reward_value,
        rewardValueUnit: entry.reward_value_unit,
        externalSystemCode: entry.external_system_code,
        externalReferenceId: entry.external_reference_id,
        redeemedAt: entry.redeemed_at?.toISOString(),
        correlationId: entry.correlation_id,
      });
      expect(payload).not.toHaveProperty('customerId');
    });

    it('throws when tenant_code/country_code enrichment has not run yet', async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID, {
        tenant_code: null,
        country_code: null,
      });

      expect(() => buildOutboxPayload(entry)).toThrow(/tenant_code\/country_code enrichment/);
    });

    it('throws when redeemed_at is not yet set', async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID, { redeemed_at: null });

      expect(() => buildOutboxPayload(entry)).toThrow(/redeemed_at/);
    });

    it('externalSystemCode/externalReferenceId stay null for the direct no-connector completion path', async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID, {
        external_system_code: null,
        external_reference_id: null,
      });

      const payload = buildOutboxPayload(entry);

      expect(payload.externalSystemCode).toBeNull();
      expect(payload.externalReferenceId).toBeNull();
    });
  });

  describe('enqueue', () => {
    it('TC-1: writes a PENDING row, attempts = 0, participating in the caller-supplied transaction', async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID);
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await repository.enqueue(client, entry);
        await client.query('COMMIT');

        expect(inserted.status).toBe('PENDING');
        expect(inserted.attempts).toBe(0);
        expect(inserted.topic).toBe('reward.redemption.completed.v1');
        expect(inserted.reward_entry_id).toBe(entry.id);
      } finally {
        client.release();
      }

      const [persisted] = await migrationDb.query<{ status: string; reward_entry_id: string }>(
        'SELECT status, reward_entry_id FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id = :id',
        { type: QueryTypes.SELECT, replacements: { id: entry.id } },
      );
      expect(persisted).toBeDefined();
      expect(persisted.status).toBe('PENDING');
    });

    it("a rolled-back transaction leaves no outbox row behind (atomicity with the caller's own transaction)", async () => {
      const entry = await insertEntry(migrationDb, TENANT_ID);
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await repository.enqueue(client, entry);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const rows = await migrationDb.query(
        'SELECT id FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id = :id',
        { type: QueryTypes.SELECT, replacements: { id: entry.id } },
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('findPendingBatch / incrementAttempts / markPublished', () => {
    async function enqueueEntry(
      overrides: Record<string, unknown> = {},
    ): Promise<{ entry: RewardRedemptionEntryRow; outboxId: string }> {
      const entry = await insertEntry(migrationDb, TENANT_ID, overrides);
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await repository.enqueue(client, entry);
        await client.query('COMMIT');
        return { entry, outboxId: inserted.id };
      } finally {
        client.release();
      }
    }

    it('TC-4/note: findPendingBatch carries the resolution fields off the joined entry row', async () => {
      const { entry, outboxId } = await enqueueEntry({
        reward_code: `RWD_${randomUUID().slice(0, 8)}`,
        tracker_code: `TRK_${randomUUID().slice(0, 8)}`,
        campaign_code: `CAMP_${randomUUID().slice(0, 8)}`,
      });

      const rows = await repository.findPendingBatch(
        await pendingBatchSizeCoveringAll(migrationDb),
      );
      const row = rows.find((r) => r.id === outboxId);

      expect(row).toBeDefined();
      expect(row?.rewardEntryId).toBe(entry.id);
      expect(row?.rewardCode).toBe(entry.reward_code);
      expect(row?.trackerCode).toBe(entry.tracker_code);
      expect(row?.campaignCode).toBe(entry.campaign_code);
      expect(row?.tenantId).toBe(entry.tenant_id);
      expect(row?.payload.rewardEntryId).toBe(entry.id);
    });

    it('TC-2: incrementAttempts increments attempts and leaves the row PENDING', async () => {
      const { outboxId } = await enqueueEntry();

      await repository.incrementAttempts(outboxId);
      await repository.incrementAttempts(outboxId);

      const [row] = await migrationDb.query<{ attempts: number; status: string }>(
        'SELECT attempts, status FROM reward_redemption.reward_tracking_dispatch_outbox WHERE id = :id',
        { type: QueryTypes.SELECT, replacements: { id: outboxId } },
      );
      expect(row.attempts).toBe(2);
      expect(row.status).toBe('PENDING');
    });

    it('TC-1/TC-8: markPublished flips status to PUBLISHED, excluding it from later findPendingBatch calls', async () => {
      const { outboxId } = await enqueueEntry();

      await repository.markPublished(outboxId);

      const [row] = await migrationDb.query<{ attempts: number; status: string }>(
        'SELECT attempts, status FROM reward_redemption.reward_tracking_dispatch_outbox WHERE id = :id',
        { type: QueryTypes.SELECT, replacements: { id: outboxId } },
      );
      expect(row.status).toBe('PUBLISHED');
      expect(row.attempts).toBe(1);

      const pending = await repository.findPendingBatch(200);
      expect(pending.find((r) => r.id === outboxId)).toBeUndefined();
    });

    it('TC-9: a row left PENDING across multiple poll-equivalent findPendingBatch calls is returned every time until published', async () => {
      const { outboxId } = await enqueueEntry();
      const batchSize = await pendingBatchSizeCoveringAll(migrationDb);

      const firstPass = await repository.findPendingBatch(batchSize);
      const secondPass = await repository.findPendingBatch(batchSize);
      expect(firstPass.some((r) => r.id === outboxId)).toBe(true);
      expect(secondPass.some((r) => r.id === outboxId)).toBe(true);

      await repository.markPublished(outboxId);

      const thirdPass = await repository.findPendingBatch(batchSize);
      expect(thirdPass.some((r) => r.id === outboxId)).toBe(false);
    });
  });
});
