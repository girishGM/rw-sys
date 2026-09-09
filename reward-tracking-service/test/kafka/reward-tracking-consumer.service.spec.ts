/**
 * T-RTS-012 — `RewardTrackingConsumerService`, exercised two ways:
 *
 * 1. `processMessage()` against a REAL `RewardTrackingIngestionService` backed by the real
 *    Postgres 16 server (root `CLAUDE.md`), never a mock — the same discipline
 *    `reward-tracking-ingestion.service.spec.ts` (T-RTS-010) and
 *    `reward-tracking-ingest.grpc-controller.spec.ts` (T-RTS-011) already establish for this
 *    service: TC-1/TC-2 name a real, observable database outcome ("reward_fact row created" /
 *    "no new row"), so only a real transaction against a real schema can actually prove it, not a
 *    mocked domain service (`AGENT-PROTOCOL.md` §3's "assert the observable property"). The DLQ
 *    producer is a hand-rolled in-memory fake (no real broker needed to prove TC-3's routing
 *    decision) — `reward-redemption-service`'s own `reward-entry-created.consumer.spec.ts`
 *    (T-RR-012, confirmed by direct read) establishes the identical split for its own sibling
 *    consumer.
 * 2. `start()`'s real kafkajs wiring (offset-commit timing, consumer group/topic) against a
 *    mocked `kafkajs` module — mirrors that same file's own second `describe` block. The
 *    `jest.mock('kafkajs', ...)` below is harmless to the first suite: `processMessage()` never
 *    touches `kafkajs` directly, only `start()` does.
 */
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Config } from '@/config/config.schema';
import { RewardTrackingIngestionService } from '@/modules/ingestion/reward-tracking-ingestion.service';
import { InboundEventLogRepository } from '@/modules/ingestion/inbound-event-log.repository';
import { RewardFactRepository } from '@/modules/ingestion/reward-fact.repository';
import { CustomerRewardLedgerRepository } from '@/modules/ingestion/customer-reward-ledger.repository';
import { CampaignRewardCounterShardRepository } from '@/modules/ingestion/campaign-reward-counter-shard.repository';
import { ShardCountResolverService } from '@/modules/ingestion/shard-count-resolver.service';
import {
  CustomerIdCryptoService,
  loadCustomerIdCryptoKeyMaterial,
} from '@/modules/ingestion/customer-id-crypto.service';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/logging.module';
import type { RewardTrackingDlqProducer } from '@/kafka/reward-tracking-dlq.producer';

// Static, file-wide `kafkajs` mock — declared (and `jest.mock`'d) before the import of
// `reward-tracking-consumer.service` below so that import's own transitive `import { Kafka } from
// 'kafkajs'` resolves to this mock, mirroring `reward-entry-created.consumer.spec.ts`'s own file
// layout (T-RR-012, confirmed by direct read).
const kafkaConsumerConnect = jest.fn().mockResolvedValue(undefined);
const kafkaConsumerSubscribe = jest.fn().mockResolvedValue(undefined);
const kafkaConsumerRun = jest.fn().mockResolvedValue(undefined);
const kafkaConsumerCommitOffsets = jest.fn().mockResolvedValue(undefined);
const kafkaConsumerDisconnect = jest.fn().mockResolvedValue(undefined);
const kafkaConsumerFactory = jest.fn(() => ({
  connect: kafkaConsumerConnect,
  subscribe: kafkaConsumerSubscribe,
  run: kafkaConsumerRun,
  commitOffsets: kafkaConsumerCommitOffsets,
  disconnect: kafkaConsumerDisconnect,
}));

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({ consumer: kafkaConsumerFactory })),
  logLevel: { NOTHING: 0 },
}));

import {
  RewardTrackingConsumerService,
  REWARD_TRACKING_COMPLETED_CONSUMER_GROUP,
  REWARD_TRACKING_COMPLETED_TOPIC,
} from '@/kafka/reward-tracking-consumer.service';

const TENANT_ID = 960_000 + Math.floor(Math.random() * 39_999);

function realDbConfigService(): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9095',
  } as Partial<Config>;
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rewardEntryId: randomUUID(),
    correlationId: randomUUID(),
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
    redeemedAt: new Date().toISOString(),
    expiresAt: null,
    ...overrides,
  };
}

describe('T-RTS-012 — RewardTrackingConsumerService.processMessage (real Postgres, fake DLQ)', () => {
  let migrationDb: Sequelize;
  let crypto: CustomerIdCryptoService;
  let ingestionService: RewardTrackingIngestionService;
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
    ingestionService = new RewardTrackingIngestionService(
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
    await ingestionService.onModuleDestroy().catch(() => undefined);
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

  function buildFakeDlq(): { publisher: RewardTrackingDlqProducer; publish: jest.Mock } {
    const publish = jest.fn().mockResolvedValue(undefined);
    return { publisher: { publish } as unknown as RewardTrackingDlqProducer, publish };
  }

  async function countRewardFact(rewardEntryId: string): Promise<number> {
    const rows = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_tracking.reward_fact WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: rewardEntryId } },
    );
    return Number(rows[0].count);
  }

  function buildConsumer(dlqPublisher: RewardTrackingDlqProducer): RewardTrackingConsumerService {
    return new RewardTrackingConsumerService(
      ingestionService,
      dlqPublisher,
      realDbConfigService(),
      1,
      5,
      crypto,
      metrics,
      new StructuredLoggerFactory(),
    );
  }

  // TC-1
  it('TC-1: a valid message on the topic creates a reward_fact row and acknowledges', async () => {
    const { publisher, publish } = buildFakeDlq();
    const consumer = buildConsumer(publisher);
    const body = validBody();

    const outcome = await consumer.processMessage({
      key: body.customerId as string,
      value: JSON.stringify(body),
    });

    expect(outcome).toBe('ACK');
    expect(await countRewardFact(body.rewardEntryId as string)).toBe(1);
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-2
  it('TC-2: a redelivered message (same rewardEntryId) creates no new row', async () => {
    const { publisher, publish } = buildFakeDlq();
    const consumer = buildConsumer(publisher);
    const body = validBody();
    const raw = { key: body.customerId as string, value: JSON.stringify(body) };

    const first = await consumer.processMessage(raw);
    const second = await consumer.processMessage(raw);

    expect(first).toBe('ACK');
    expect(second).toBe('ACK');
    expect(await countRewardFact(body.rewardEntryId as string)).toBe(1);
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-3
  it('TC-3: a malformed message (missing a required field) is routed to the DLQ, never calls the domain method, no row created', async () => {
    const { publisher, publish } = buildFakeDlq();
    const consumer = buildConsumer(publisher);
    const { campaignCode: _omit, ...withoutCampaignCode } = validBody();
    const customerId = withoutCampaignCode.customerId as string;

    const outcome = await consumer.processMessage({
      key: customerId,
      value: JSON.stringify(withoutCampaignCode),
    });

    expect(outcome).toBe('DLQ');
    expect(publish).toHaveBeenCalledTimes(1);
    const [key, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    // Post-review R6 fix: the DLQ key is a hash of the source topic's own plaintext partition key
    // (`customerId`), never the plaintext value itself — see reward-tracking-consumer.service.ts's
    // own header.
    expect(key).toBe(crypto.hash(customerId));
    expect(message.error).toMatch(/campaignCode/);
    expect(typeof message.failedAt).toBe('string');
    expect(await countRewardFact(withoutCampaignCode.rewardEntryId as string)).toBe(0);
  });

  // R6 (post-review fix) — the exact gap the independent review of this task caught: a message
  // that is valid JSON and carries a perfectly well-formed `customerId`, but fails validation on
  // some OTHER field, must never publish that `customerId` to the DLQ topic — neither in the
  // body nor as the Kafka key.
  it('R6 (post-review fix): DLQ payload/key never contain the plaintext customerId — schema-parses-but-invalid-field path', async () => {
    const { publisher, publish } = buildFakeDlq();
    const consumer = buildConsumer(publisher);
    const { campaignCode: _omit, ...withoutCampaignCode } = validBody();
    const customerId = withoutCampaignCode.customerId as string;

    await consumer.processMessage({
      key: customerId,
      value: JSON.stringify(withoutCampaignCode),
    });

    expect(publish).toHaveBeenCalledTimes(1);
    const [key, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    const serializedMessage = JSON.stringify(message);
    expect(key).not.toBe(customerId);
    expect(key).toBe(crypto.hash(customerId));
    expect(serializedMessage).not.toContain(customerId);
    expect(message.customerId).toBeUndefined();
    expect(message.customerIdHash).toBe(crypto.hash(customerId));
  });

  it('TC-3b: a message that is not valid JSON at all is routed to the DLQ with the raw value preserved', async () => {
    const { publisher, publish } = buildFakeDlq();
    const consumer = buildConsumer(publisher);

    const outcome = await consumer.processMessage({ key: 'cust-1', value: 'not-json{{{' });

    expect(outcome).toBe('DLQ');
    const [, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(message.raw).toBe('not-json{{{');
  });

  // R6 (post-review fix) — same guarantee as the test above, for the OTHER path the reviewer
  // named explicitly: a message that never parses as JSON at all still arrives with the source
  // topic's own plaintext `customerId` partition key, which must be hashed exactly the same way.
  it('R6 (post-review fix): DLQ key never contains the plaintext customerId — not-valid-JSON-at-all path', async () => {
    const { publisher, publish } = buildFakeDlq();
    const consumer = buildConsumer(publisher);
    const customerId = `customer-${randomUUID()}`;

    const outcome = await consumer.processMessage({ key: customerId, value: 'not-json{{{' });

    expect(outcome).toBe('DLQ');
    const [key, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(message.raw).toBe('not-json{{{');
    expect(key).not.toBe(customerId);
    expect(key).toBe(crypto.hash(customerId));
    expect(JSON.stringify(message)).not.toContain(customerId);
  });

  it('a non-duplicate domain-method failure propagates uncaught, is never DLQ-routed', async () => {
    const { publisher, publish } = buildFakeDlq();
    const consumer = buildConsumer(publisher);
    // A schema-valid envelope that breaks a genuine, downstream infra assumption instead of a
    // validation rule — simulated here by closing the real ingestion service's own pool first, so
    // `applyRewardTrackingEvent()` fails for an infra reason, never a validation reason.
    await ingestionService.onModuleDestroy();
    const body = validBody();

    await expect(
      consumer.processMessage({ key: body.customerId as string, value: JSON.stringify(body) }),
    ).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-4
  it('TC-4: customerId never appears in any log line during a valid ingest or a malformed-message DLQ route', async () => {
    const captured: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => JSON.stringify(arg)).join(' '));
      }),
    );
    // T-RTS-049: the applied-ingest log line and the DLQ-routing log line now go through
    // `StructuredLogger` (console-based), not Nest's `Logger` — captured here too so this test can
    // still fail if a future change reintroduces a plaintext `customerId` into either path.
    const consoleSpies = (['log', 'warn', 'error', 'debug'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(' '));
      }),
    );

    try {
      const { publisher } = buildFakeDlq();
      const consumer = buildConsumer(publisher);
      const body = validBody();
      await consumer.processMessage({
        key: body.customerId as string,
        value: JSON.stringify(body),
      });

      const { campaignCode: _omit, ...malformed } = validBody();
      await consumer.processMessage({
        key: malformed.customerId as string,
        value: JSON.stringify(malformed),
      });

      const allLogText = captured.join('\n');
      expect(allLogText).not.toContain(body.customerId as string);
      expect(allLogText).not.toContain(malformed.customerId as string);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });

  // T-RTS-049 — defect regression. Proven red against the pre-fix code (see this task's own
  // completion report) before this fix landed.
  describe('T-RTS-049 — observability wiring', () => {
    it("TC-2: increments reward_tracking_events_ingested_total{channel:'KAFKA', outcome:'applied'} and logs correlationId on a fresh ingest", async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const { publisher } = buildFakeDlq();
        const consumer = buildConsumer(publisher);
        const body = validBody();
        const before = metrics.getCounterValue('reward_tracking_events_ingested_total', {
          channel: 'KAFKA',
          outcome: 'applied',
        });

        await consumer.processMessage({
          key: body.customerId as string,
          value: JSON.stringify(body),
        });

        expect(
          metrics.getCounterValue('reward_tracking_events_ingested_total', {
            channel: 'KAFKA',
            outcome: 'applied',
          }),
        ).toBe(before + 1);

        const entries = logSpy.mock.calls
          .map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
          .filter((entry) => entry.context === 'RewardTrackingConsumerService');
        expect(entries.some((entry) => entry.correlationId === body.correlationId)).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("TC-2/TC-3: a message routed to the DLQ increments outcome:'failed' and logs a best-effort correlationId", async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { publisher } = buildFakeDlq();
        const consumer = buildConsumer(publisher);
        const { campaignCode: _omit, ...withoutCampaignCode } = validBody();
        const before = metrics.getCounterValue('reward_tracking_events_ingested_total', {
          channel: 'KAFKA',
          outcome: 'failed',
        });

        const outcome = await consumer.processMessage({
          key: withoutCampaignCode.customerId as string,
          value: JSON.stringify(withoutCampaignCode),
        });

        expect(outcome).toBe('DLQ');
        expect(
          metrics.getCounterValue('reward_tracking_events_ingested_total', {
            channel: 'KAFKA',
            outcome: 'failed',
          }),
        ).toBe(before + 1);

        const entries = errorSpy.mock.calls
          .map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
          .filter((entry) => entry.context === 'RewardTrackingConsumerService');
        expect(entries).toHaveLength(1);
        expect(entries[0].correlationId).toBe(withoutCampaignCode.correlationId);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("TC-3: a message that never parses as JSON falls back to correlationId:'unknown', never throwing inside the logger itself", async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { publisher } = buildFakeDlq();
        const consumer = buildConsumer(publisher);

        const outcome = await consumer.processMessage({ key: 'cust-1', value: 'not-json{{{' });

        expect(outcome).toBe('DLQ');
        const entries = errorSpy.mock.calls
          .map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
          .filter((entry) => entry.context === 'RewardTrackingConsumerService');
        expect(entries).toHaveLength(1);
        expect(entries[0].correlationId).toBe('unknown');
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});

describe('T-RTS-012 — RewardTrackingConsumerService.start() — real offset-commit wiring (mocked kafkajs)', () => {
  type RunConfig = {
    autoCommit?: boolean;
    eachMessage: (payload: {
      topic: string;
      partition: number;
      message: { key: Buffer | null; value: Buffer | null; offset: string };
    }) => Promise<void>;
  };

  // Real primitives (not mocks) — same instance shapes the first describe block above uses, needed
  // because `RewardTrackingConsumerService`'s constructor now takes a real `CustomerIdCryptoService`
  // (R6 fix, post-review) and, as of T-RTS-049, a real `MetricsService`/`StructuredLoggerFactory`,
  // even in this mocked-kafkajs suite, which never asserts on hashed/metric/log values itself but
  // still needs working instances for `validateWithBoundedRetries`/the DLQ-routing log-and-meter
  // call.
  const crypto = new CustomerIdCryptoService(loadCustomerIdCryptoKeyMaterial());
  const metrics = new MetricsService();
  const loggers = new StructuredLoggerFactory();

  beforeEach(() => {
    kafkaConsumerConnect.mockClear().mockResolvedValue(undefined);
    kafkaConsumerSubscribe.mockClear().mockResolvedValue(undefined);
    kafkaConsumerRun.mockClear().mockResolvedValue(undefined);
    kafkaConsumerCommitOffsets.mockClear().mockResolvedValue(undefined);
    kafkaConsumerDisconnect.mockClear().mockResolvedValue(undefined);
    kafkaConsumerFactory.mockClear();
  });

  async function buildStartedConsumer(
    applyImpl: jest.Mock,
    publishImpl: jest.Mock = jest.fn().mockResolvedValue(undefined),
  ): Promise<RunConfig> {
    const fakeIngestionService = {
      applyRewardTrackingEvent: applyImpl,
    } as unknown as RewardTrackingIngestionService;
    const dlqPublisher = { publish: publishImpl } as unknown as RewardTrackingDlqProducer;
    const configService = { get: () => 'localhost:9095' } as unknown as ConfigService<Config, true>;
    const consumer = new RewardTrackingConsumerService(
      fakeIngestionService,
      dlqPublisher,
      configService,
      1,
      5,
      crypto,
      metrics,
      loggers,
    );
    await consumer.start();
    return kafkaConsumerRun.mock.calls[0][0] as RunConfig;
  }

  it('disables kafkajs auto-commit and joins the fixed, shared consumer group/topic', async () => {
    const runConfig = await buildStartedConsumer(
      jest.fn().mockResolvedValue({ rewardEntryId: 'x', status: 'applied' }),
    );

    expect(runConfig.autoCommit).toBe(false);
    expect(kafkaConsumerFactory).toHaveBeenCalledWith({
      groupId: REWARD_TRACKING_COMPLETED_CONSUMER_GROUP,
    });
    expect(kafkaConsumerSubscribe).toHaveBeenCalledWith({
      topic: REWARD_TRACKING_COMPLETED_TOPIC,
      fromBeginning: false,
    });
  });

  it('commits the offset only after processMessage resolves successfully (ACK)', async () => {
    const runConfig = await buildStartedConsumer(
      jest.fn().mockResolvedValue({ rewardEntryId: 'x', status: 'applied' }),
    );

    await runConfig.eachMessage({
      topic: REWARD_TRACKING_COMPLETED_TOPIC,
      partition: 0,
      message: {
        key: Buffer.from('cust-1'),
        value: Buffer.from(JSON.stringify(validBody())),
        offset: '41',
      },
    });

    expect(kafkaConsumerCommitOffsets).toHaveBeenCalledWith([
      { topic: REWARD_TRACKING_COMPLETED_TOPIC, partition: 0, offset: '42' },
    ]);
  });

  it('does NOT commit the offset when processMessage throws (a non-duplicate applyRewardTrackingEvent failure)', async () => {
    const runConfig = await buildStartedConsumer(
      jest.fn().mockRejectedValue(new Error('simulated DB outage')),
    );

    await expect(
      runConfig.eachMessage({
        topic: REWARD_TRACKING_COMPLETED_TOPIC,
        partition: 0,
        message: {
          key: Buffer.from('cust-1'),
          value: Buffer.from(JSON.stringify(validBody())),
          offset: '41',
        },
      }),
    ).rejects.toThrow('simulated DB outage');

    expect(kafkaConsumerCommitOffsets).not.toHaveBeenCalled();
  });

  // TC-3 (real wiring): the consumer must keep running and commit past a DLQ-routed message
  // rather than crash-loop on it.
  it('TC-3: still commits the offset for a schema-invalid message routed to the DLQ — consumer continues, no crash', async () => {
    const { campaignCode: _omit, ...withoutCampaignCode } = validBody();
    const runConfig = await buildStartedConsumer(jest.fn());

    await runConfig.eachMessage({
      topic: REWARD_TRACKING_COMPLETED_TOPIC,
      partition: 2,
      message: {
        key: Buffer.from('cust-1'),
        value: Buffer.from(JSON.stringify(withoutCampaignCode)),
        offset: '7',
      },
    });

    expect(kafkaConsumerCommitOffsets).toHaveBeenCalledWith([
      { topic: REWARD_TRACKING_COMPLETED_TOPIC, partition: 2, offset: '8' },
    ]);
  });

  it('stop() disconnects a started consumer; calling start() twice only connects once', async () => {
    const fakeIngestionService = {
      applyRewardTrackingEvent: jest
        .fn()
        .mockResolvedValue({ rewardEntryId: 'x', status: 'applied' }),
    } as unknown as RewardTrackingIngestionService;
    const dlqPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as RewardTrackingDlqProducer;
    const configService = { get: () => 'localhost:9095' } as unknown as ConfigService<Config, true>;
    const consumer = new RewardTrackingConsumerService(
      fakeIngestionService,
      dlqPublisher,
      configService,
      1,
      5,
      crypto,
      metrics,
      loggers,
    );

    await consumer.start();
    await consumer.start();
    expect(kafkaConsumerConnect).toHaveBeenCalledTimes(1);

    await consumer.stop();
    expect(kafkaConsumerDisconnect).toHaveBeenCalledTimes(1);

    await consumer.stop();
    expect(kafkaConsumerDisconnect).toHaveBeenCalledTimes(1);
  });
});
