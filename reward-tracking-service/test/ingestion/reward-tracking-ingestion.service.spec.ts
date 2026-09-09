/**
 * T-RTS-010 — `RewardTrackingIngestionService.applyRewardTrackingEvent()`, exercised against the
 * real Postgres 16 server (root `CLAUDE.md`), never a mock/in-memory DB — same convention
 * `reward-redemption-service`'s own `redemption-state-machine.service.spec.ts` already establishes
 * for its own transaction-owning service. Every test uses its own randomly-generated
 * `campaignCode`/`customerId` so tests never collide with each other's `customer_reward_ledger`/
 * `campaign_reward_counter_shard` rows even though they share one `TENANT_ID`.
 */
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Config } from '@/config/config.schema';
import {
  RewardTrackingIngestionService,
  InvalidRewardTrackingEventInputError,
  type ApplyRewardTrackingEventInput,
} from '@/modules/ingestion/reward-tracking-ingestion.service';
import { InboundEventLogRepository } from '@/modules/ingestion/inbound-event-log.repository';
import { RewardFactRepository } from '@/modules/ingestion/reward-fact.repository';
import { CustomerRewardLedgerRepository } from '@/modules/ingestion/customer-reward-ledger.repository';
import {
  CampaignRewardCounterShardRepository,
  NULL_GROUPING_SENTINEL,
} from '@/modules/ingestion/campaign-reward-counter-shard.repository';
import { ShardCountResolverService } from '@/modules/ingestion/shard-count-resolver.service';
import {
  CustomerIdCryptoService,
  loadCustomerIdCryptoKeyMaterial,
} from '@/modules/ingestion/customer-id-crypto.service';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/logging.module';

const TENANT_ID = 950_000 + Math.floor(Math.random() * 49_999);
const REAL_SHARD_COUNT = 32; // T-RTS-002's own seeded default for tracking.campaignCounterShardCount

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

function baseInput(
  overrides: Partial<ApplyRewardTrackingEventInput> = {},
): ApplyRewardTrackingEventInput {
  return {
    rewardEntryId: randomUUID(),
    correlationId: randomUUID(),
    receivedChannel: 'REST',
    tenantId: TENANT_ID,
    tenantCode: 'T1',
    countryCode: 'US',
    customerId: `customer-${randomUUID()}`,
    campaignCode: `CAMP-${randomUUID().slice(0, 8)}`,
    trackerCode: 'TRK1',
    trackerComponentCode: 'COMP1',
    merchantCode: null,
    rewardCode: 'RWD1',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'CURRENCY',
    unitCode: 'USD',
    rewardValue: '5.00',
    rewardValueUnit: 'USD',
    externalSystemCode: null,
    externalReferenceId: null,
    promoCodeConfigId: null,
    promoCodeConfigVersionNo: null,
    redeemedAt: new Date(),
    expiresAt: null,
    ...overrides,
  };
}

describe('T-RTS-010 — RewardTrackingIngestionService.applyRewardTrackingEvent', () => {
  let migrationDb: Sequelize;
  let crypto: CustomerIdCryptoService;
  let service: RewardTrackingIngestionService;
  let shardCountResolver: ShardCountResolverService;
  let metrics: MetricsService;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    crypto = new CustomerIdCryptoService(loadCustomerIdCryptoKeyMaterial());
  });

  beforeEach(() => {
    const config = realDbConfigService();
    shardCountResolver = new ShardCountResolverService(config);
    metrics = new MetricsService();
    service = new RewardTrackingIngestionService(
      config,
      new InboundEventLogRepository(),
      new RewardFactRepository(),
      new CustomerRewardLedgerRepository(),
      new CampaignRewardCounterShardRepository(),
      shardCountResolver,
      crypto,
      metrics,
      new StructuredLoggerFactory(),
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    await shardCountResolver.onModuleDestroy();
  });

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_tracking.campaign_reward_counter_shard WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await migrationDb.query(
      'DELETE FROM reward_tracking.customer_reward_ledger WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await migrationDb.query('DELETE FROM reward_tracking.reward_fact WHERE tenant_id = :tenantId', {
      type: QueryTypes.RAW,
      replacements: { tenantId: TENANT_ID },
    });
    await migrationDb.query(
      `DELETE FROM reward_tracking.inbound_event_log
         WHERE reward_entry_id IN (
           SELECT reward_entry_id FROM reward_tracking.reward_fact WHERE tenant_id = :tenantId
         ) OR payload->>'tenantId' = :tenantIdStr`,
      {
        type: QueryTypes.RAW,
        replacements: { tenantId: TENANT_ID, tenantIdStr: String(TENANT_ID) },
      },
    );
    await migrationDb.close();
  });

  it('TC-1: ingest a new event — reward_fact appended, ledger row created at (value, 1), one shard row incremented', async () => {
    const input = baseInput();

    const result = await service.applyRewardTrackingEvent(input);

    expect(result.status).toBe('applied');
    expect(result.rewardFact.reward_entry_id).toBe(input.rewardEntryId);
    expect(result.rewardFact.customer_id_encrypted).not.toBe(input.customerId);
    expect(result.rewardFact.customer_id_hash).toBe(crypto.hash(input.customerId));

    const [factRow] = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: input.rewardEntryId } },
    );
    expect(factRow.count).toBe('1');

    const [ledgerRow] = await migrationDb.query<{
      total_reward_value: string;
      total_reward_count: number;
    }>(
      `SELECT total_reward_value, total_reward_count FROM reward_tracking.customer_reward_ledger
        WHERE tenant_id = :tenantId AND customer_id_hash = :hash AND campaign_code = :campaignCode`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: TENANT_ID,
          hash: crypto.hash(input.customerId),
          campaignCode: input.campaignCode,
        },
      },
    );
    expect(Number(ledgerRow.total_reward_value)).toBeCloseTo(5.0);
    expect(ledgerRow.total_reward_count).toBe(1);

    const shardRows = await migrationDb.query<{
      total_reward_value: string;
      total_reward_count: number;
    }>(
      `SELECT total_reward_value, total_reward_count FROM reward_tracking.campaign_reward_counter_shard
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, campaignCode: input.campaignCode },
      },
    );
    expect(shardRows).toHaveLength(1);
    expect(Number(shardRows[0].total_reward_value)).toBeCloseTo(5.0);
    expect(shardRows[0].total_reward_count).toBe(1);
  });

  it('TC-2: redelivery of the same rewardEntryId is a true no-op (verification step 2)', async () => {
    const input = baseInput();

    const first = await service.applyRewardTrackingEvent(input);
    const second = await service.applyRewardTrackingEvent(input);

    expect(first.status).toBe('applied');
    expect(second.status).toBe('duplicate');
    expect(second.rewardFact.id).toBe(first.rewardFact.id);

    const [{ count }] = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: input.rewardEntryId } },
    );
    expect(count).toBe('1');

    const [ledgerRow] = await migrationDb.query<{ total_reward_count: number }>(
      `SELECT total_reward_count FROM reward_tracking.customer_reward_ledger
        WHERE tenant_id = :tenantId AND customer_id_hash = :hash AND campaign_code = :campaignCode`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: TENANT_ID,
          hash: crypto.hash(input.customerId),
          campaignCode: input.campaignCode,
        },
      },
    );
    expect(ledgerRow.total_reward_count).toBe(1);

    const shardRows = await migrationDb.query<{ total_reward_count: number }>(
      `SELECT total_reward_count FROM reward_tracking.campaign_reward_counter_shard
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, campaignCode: input.campaignCode },
      },
    );
    expect(shardRows).toHaveLength(1);
    expect(shardRows[0].total_reward_count).toBe(1);
  });

  it('TC-3: two events for the same customer/campaign/tracker/component/category/kind accumulate correctly', async () => {
    const shared = {
      customerId: `customer-${randomUUID()}`,
      campaignCode: `CAMP-${randomUUID().slice(0, 8)}`,
    };

    await service.applyRewardTrackingEvent(baseInput({ ...shared, rewardValue: '5.00' }));
    await service.applyRewardTrackingEvent(baseInput({ ...shared, rewardValue: '7.50' }));

    const [ledgerRow] = await migrationDb.query<{
      total_reward_value: string;
      total_reward_count: number;
    }>(
      `SELECT total_reward_value, total_reward_count FROM reward_tracking.customer_reward_ledger
        WHERE tenant_id = :tenantId AND customer_id_hash = :hash AND campaign_code = :campaignCode`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: TENANT_ID,
          hash: crypto.hash(shared.customerId),
          campaignCode: shared.campaignCode,
        },
      },
    );
    expect(Number(ledgerRow.total_reward_value)).toBeCloseTo(12.5);
    expect(ledgerRow.total_reward_count).toBe(2);
  });

  it('TC-4: two events hashing to different shards for the same campaign produce two independent shard rows', async () => {
    const campaignCode = `CAMP-${randomUUID().slice(0, 8)}`;
    const [seedA, seedB] = await findTwoDifferentShardSeeds(migrationDb, REAL_SHARD_COUNT);

    await service.applyRewardTrackingEvent(baseInput({ campaignCode, rewardEntryId: seedA }));
    await service.applyRewardTrackingEvent(baseInput({ campaignCode, rewardEntryId: seedB }));

    const shardRows = await migrationDb.query<{ shard_key: number; total_reward_count: number }>(
      `SELECT shard_key, total_reward_count FROM reward_tracking.campaign_reward_counter_shard
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID, campaignCode } },
    );
    expect(shardRows).toHaveLength(2);
    expect(shardRows[0].shard_key).not.toBe(shardRows[1].shard_key);
    expect(shardRows[0].total_reward_count).toBe(1);
    expect(shardRows[1].total_reward_count).toBe(1);
  });

  it('TC-5: a failure between the reward_fact insert and the ledger upsert rolls back the whole transaction', async () => {
    const realPool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
    });
    const realClient = await realPool.connect();
    const originalQuery = realClient.query.bind(realClient);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg's own overloaded query signature
    (realClient as any).query = (async (text: unknown, params?: unknown[]) => {
      if (typeof text === 'string' && text.includes('customer_reward_ledger')) {
        throw new Error('simulated failure mid-transaction');
      }
      return originalQuery(text as string, params as never);
    }) as PoolClient['query'];
    const faultyPool = {
      connect: async () => realClient,
      end: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal structural fake, T-RTS-010
    } as any as Pool;

    const config = realDbConfigService();
    const faultyService = new RewardTrackingIngestionService(
      config,
      new InboundEventLogRepository(),
      new RewardFactRepository(),
      new CustomerRewardLedgerRepository(),
      new CampaignRewardCounterShardRepository(),
      shardCountResolver,
      crypto,
      new MetricsService(),
      new StructuredLoggerFactory(),
      faultyPool,
    );

    const input = baseInput();
    await expect(faultyService.applyRewardTrackingEvent(input)).rejects.toThrow(
      'simulated failure mid-transaction',
    );

    // `faultyService.applyRewardTrackingEvent`'s own `runInTransaction` already released
    // `realClient` back to `realPool` in its own `finally` block (it is, from the service's point
    // of view, an ordinary pooled client) — releasing it a second time here would throw "Release
    // called on client which has already been released to the pool."
    await realPool.end();

    const [{ count: factCount }] = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: input.rewardEntryId } },
    );
    expect(factCount).toBe('0');

    const [{ count: logCount }] = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.inbound_event_log WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: input.rewardEntryId } },
    );
    expect(logCount).toBe('0');
  });

  it('TC-7: an event with reward_kind: null succeeds, accumulating under a NULL-keyed ledger/shard row', async () => {
    const input = baseInput({ rewardKind: null, unitType: null, unitCode: null });

    const result = await service.applyRewardTrackingEvent(input);

    expect(result.status).toBe('applied');
    expect(result.rewardFact.reward_kind).toBeNull();

    const [ledgerRow] = await migrationDb.query<{
      reward_kind: string | null;
      total_reward_count: number;
    }>(
      `SELECT reward_kind, total_reward_count FROM reward_tracking.customer_reward_ledger
        WHERE tenant_id = :tenantId AND customer_id_hash = :hash AND campaign_code = :campaignCode`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: TENANT_ID,
          hash: crypto.hash(input.customerId),
          campaignCode: input.campaignCode,
        },
      },
    );
    expect(ledgerRow.reward_kind).toBeNull();
    expect(ledgerRow.total_reward_count).toBe(1);

    // Raw storage detail (`campaign-reward-counter-shard.repository.ts`'s own header): `reward_kind`
    // is part of this table's PRIMARY KEY, so Postgres forces it NOT NULL regardless of the
    // `CREATE TABLE`'s own `NULL` declaration — `NULL_GROUPING_SENTINEL` stands in for SQL `NULL` at
    // the storage layer here, and only `CampaignRewardCounterShardRepository.upsert`'s own returned
    // row translates it back (see the next test, which asserts that translation directly).
    const shardRows = await migrationDb.query<{ reward_kind: string | null }>(
      `SELECT reward_kind FROM reward_tracking.campaign_reward_counter_shard
        WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: TENANT_ID, campaignCode: input.campaignCode },
      },
    );
    expect(shardRows).toHaveLength(1);
    expect(shardRows[0].reward_kind).toBe(NULL_GROUPING_SENTINEL);
  });

  it('CampaignRewardCounterShardRepository.upsert translates NULL_GROUPING_SENTINEL back to null on its own returned row', async () => {
    const pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
    });
    const client = await pool.connect();
    try {
      const repository = new CampaignRewardCounterShardRepository();
      await client.query('BEGIN');
      const row = await repository.upsert(
        client,
        {
          tenant_id: TENANT_ID,
          campaign_code: `CAMP-${randomUUID().slice(0, 8)}`,
          reward_category: 'CASHBACK',
          reward_kind: null,
          unit_type: null,
          unit_code: null,
          reward_value: '1.00',
          shardSeed: randomUUID(),
        },
        REAL_SHARD_COUNT,
      );
      expect(row.reward_kind).toBeNull();
      expect(row.unit_type).toBeNull();
      expect(row.unit_code).toBeNull();
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('customerId never appears in plaintext in the persisted inbound_event_log.payload', async () => {
    const input = baseInput();

    await service.applyRewardTrackingEvent(input);

    const [logRow] = await migrationDb.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM reward_tracking.inbound_event_log WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: input.rewardEntryId } },
    );
    expect(JSON.stringify(logRow.payload)).not.toContain(input.customerId);
    expect(logRow.payload.customerId).toBeUndefined();
    expect(typeof logRow.payload.customerIdEncrypted).toBe('string');
  });

  // T-INT-050 — deviation: `assertWellFormed()`'s own `REQUIRED_STRING_FIELDS` guard (this file,
  // not in T-INT-050's own "Files owned" list — see completion report) previously re-rejected an
  // empty `rewardValueUnit` even after all three transport adapters were fixed to tolerate it,
  // producing an uncaught `InvalidRewardTrackingEventInputError`/HTTP 500 on the identical shape of
  // reward T-INT-050 exists to unblock. Regression: this must now succeed end to end.
  it("T-INT-050: applies successfully with an empty rewardValueUnit, persisting reward_value_unit = ''", async () => {
    const input = baseInput({ rewardValueUnit: '' });

    const result = await service.applyRewardTrackingEvent(input);

    expect(result.status).toBe('applied');
    expect(result.rewardFact.reward_value_unit).toBe('');
  });

  it('rejects a malformed input (missing a required field) without writing anything', async () => {
    const input = baseInput({ campaignCode: '' });

    await expect(service.applyRewardTrackingEvent(input)).rejects.toThrow(
      InvalidRewardTrackingEventInputError,
    );

    const [{ count }] = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: input.rewardEntryId } },
    );
    expect(count).toBe('0');
  });

  // T-RTS-049 — defect regression: applyRewardTrackingEvent() must increment the observability
  // counters and emit a structured log carrying correlationId as a separate field, at the ONE
  // shared call site every channel goes through (R8). Proven red against the pre-fix code (see
  // this task's own completion report) before this fix landed.
  describe('T-RTS-049 — observability wiring', () => {
    it('TC-2: increments reward_tracking_events_ingested_total{channel,outcome} and reward_tracking_shard_write_total{campaign_code} on a fresh (applied) ingest', async () => {
      const input = baseInput({ receivedChannel: 'REST' });
      const before = metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'REST',
        outcome: 'applied',
      });
      const shardBefore = metrics.getCounterValue('reward_tracking_shard_write_total', {
        campaign_code: input.campaignCode,
      });

      await service.applyRewardTrackingEvent(input);

      expect(
        metrics.getCounterValue('reward_tracking_events_ingested_total', {
          channel: 'REST',
          outcome: 'applied',
        }),
      ).toBe(before + 1);
      expect(
        metrics.getCounterValue('reward_tracking_shard_write_total', {
          campaign_code: input.campaignCode,
        }),
      ).toBe(shardBefore + 1);
    });

    it('TC-2: a duplicate redelivery increments outcome=duplicate but never a second shard write', async () => {
      const input = baseInput({ receivedChannel: 'KAFKA' });
      await service.applyRewardTrackingEvent(input);
      const shardAfterFirst = metrics.getCounterValue('reward_tracking_shard_write_total', {
        campaign_code: input.campaignCode,
      });
      const duplicateBefore = metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'KAFKA',
        outcome: 'duplicate',
      });

      await service.applyRewardTrackingEvent(input);

      expect(
        metrics.getCounterValue('reward_tracking_events_ingested_total', {
          channel: 'KAFKA',
          outcome: 'duplicate',
        }),
      ).toBe(duplicateBefore + 1);
      expect(
        metrics.getCounterValue('reward_tracking_shard_write_total', {
          campaign_code: input.campaignCode,
        }),
      ).toBe(shardAfterFirst);
    });

    it('TC-2/TC-3: emits a structured log line carrying correlationId as its own separate JSON field, never string-interpolated', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const input = baseInput();

        await service.applyRewardTrackingEvent(input);

        const entries = logSpy.mock.calls
          .map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
          .filter((entry) => entry.context === 'RewardTrackingIngestionService');
        expect(entries).toHaveLength(1);
        expect(entries[0].correlationId).toBe(input.correlationId);
        expect(entries[0].status).toBe('applied');
        expect(JSON.stringify(entries[0])).not.toContain(input.customerId);
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});

/**
 * Picks two candidate ids whose `abs(hashtext(id)) % n` land on different shards — TC-4 needs two
 * events that genuinely spread across independent shard rows, not two that happen to collide by
 * chance. Computed via the real DB's own `hashtext()` (a Postgres-internal function with no JS
 * equivalent) rather than reimplementing that hash client-side.
 */
async function findTwoDifferentShardSeeds(db: Sequelize, n: number): Promise<[string, string]> {
  const seen = new Map<number, string>();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = randomUUID();
    const [{ shard }] = await db.query<{ shard: number }>(
      'SELECT (abs(hashtext(:candidate)) % :n)::int AS shard',
      { type: QueryTypes.SELECT, replacements: { candidate, n } },
    );
    if (!seen.has(shard)) {
      seen.set(shard, candidate);
      if (seen.size >= 2) {
        const [a, b] = [...seen.values()];
        return [a, b];
      }
    }
  }
  throw new Error(`could not find two candidates landing on different shards (n=${n})`);
}
