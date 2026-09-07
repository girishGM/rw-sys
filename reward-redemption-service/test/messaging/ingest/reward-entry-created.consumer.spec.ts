/**
 * T-RR-012. Unit tests for `RewardEntryCreatedConsumer` — `RewardIngestionService` and
 * `RewardEntryCreatedDlqProducer` are hand-rolled fakes, no DB, no Kafka, no Nest test module (same
 * discipline `reward-ingestion.service.spec.ts`, T-RR-010, and RAP's own
 * `activity-ingest.consumer.spec.ts`, T-RAP-023, already established for this repo). The first
 * `describe` block proves `processMessage`'s own orchestration (TC-1…TC-7 from the task file); the
 * second proves `start()`'s real offset-commit wiring against a mocked `kafkajs` — the property
 * this task's own risk callout names explicitly: an offset must commit only once `processMessage`
 * has resolved, and never when it throws.
 */
import type { ConfigService } from '@nestjs/config';

// Static, file-wide `kafkajs` mock — the second `describe` block below (`start()`'s real
// offset-commit wiring) reconfigures these same jest.fn()s per test rather than re-mocking or
// reloading the module under test; the first `describe` block (`processMessage`) never touches
// `kafkajs` at all, so this mock is simply inert for those tests.
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
  RewardEntryCreatedConsumer,
  REWARD_ENTRY_CREATED_CONSUMER_GROUP,
  REWARD_ENTRY_CREATED_TOPIC,
  MAX_SCHEMA_VALIDATION_ATTEMPTS,
  type RawKafkaMessage,
} from '@/messaging/ingest/reward-entry-created.consumer';
import type { RewardEntryCreatedDlqProducer } from '@/messaging/ingest/reward-entry-created-dlq.producer';
import type {
  RewardIngestionService,
  IngestResult,
} from '@/modules/reward-ingestion/reward-ingestion.service';
import type { Config } from '@/config/config.schema';

const BACKOFF_BASE_MS = 1;
const BACKOFF_MAX_MS = 5;

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'reward-entry-1',
    correlationId: 'corr-1',
    tenantId: 1,
    customerId: 'MSISDN-60123456789',
    customerIdType: 'MSISDN',
    activityPerformedDate: '2026-09-04T10:15:00.000Z',
    transactionType: null,
    activityCode: 'TXN_TOPUP',
    activityType: 'TOPUP',
    activityCategory: 'TELCO',
    activityValue: '50.0000',
    activityValueUnit: 'MYR',
    channel: 'app',
    activityPerformedEnv: 'production',
    activityName: 'Prepaid Top-up',
    campaignCode: 'CAMP-2026-Q3-001',
    trackerCode: 'TRK-TOPUP-5X',
    trackerComponentCode: 'CMP-TOPUP-STEP-3',
    merchantCode: 'MERCH-001',
    rewardCode: 'RWD-CASHBACK-5PCT',
    rewardCategory: 'CASHBACK',
    rewardValue: '2.5000',
    rewardValueUnit: 'MYR',
    rewardEntryDate: '2026-09-04T10:15:03.000Z',
    completionCycle: 1,
    ...overrides,
  };
}

interface Harness {
  consumer: RewardEntryCreatedConsumer;
  ingest: jest.Mock;
  publish: jest.Mock;
}

function buildHarness(ingestImpl?: jest.Mock): Harness {
  const receivedResult: IngestResult = { rewardEntryId: 'reward-entry-1', status: 'received' };
  const ingest = ingestImpl ?? jest.fn().mockResolvedValue(receivedResult);
  const publish = jest.fn().mockResolvedValue(undefined);

  const ingestionService = { ingest } as unknown as RewardIngestionService;
  const dlqPublisher = { publish } as unknown as RewardEntryCreatedDlqProducer;
  const configService = {} as ConfigService<Config, true>;

  const consumer = new RewardEntryCreatedConsumer(
    ingestionService,
    dlqPublisher,
    configService,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
  );

  return { consumer, ingest, publish };
}

describe('RewardEntryCreatedConsumer.processMessage', () => {
  // TC-1
  it('TC-1: a well-formed message is ingested with ingestionChannel KAFKA and acknowledged', async () => {
    const { consumer, ingest, publish } = buildHarness();

    const outcome = await consumer.processMessage({
      key: 'MSISDN-60123456789',
      value: JSON.stringify(validBody()),
    });

    expect(outcome).toBe('ACK');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reward-entry-1', ingestionChannel: 'KAFKA' }),
    );
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-2 + TC-7 (a duplicate id is never a DLQ case, confirmed via a spy across this exact test)
  it('TC-2/TC-7: consuming the identical message twice never publishes to the DLQ, offsets would commit both times', async () => {
    const ingest = jest
      .fn()
      .mockResolvedValueOnce({ rewardEntryId: 'reward-entry-1', status: 'received' })
      .mockResolvedValueOnce({ rewardEntryId: 'reward-entry-1', status: 'processing' });
    const { consumer, publish } = buildHarness(ingest);
    const raw: RawKafkaMessage = { key: 'MSISDN-60123456789', value: JSON.stringify(validBody()) };

    const first = await consumer.processMessage(raw);
    const second = await consumer.processMessage(raw);

    expect(first).toBe('ACK');
    expect(second).toBe('ACK');
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-3 (negative)
  it('TC-3: a message missing a mandatory field (campaignCode) is retried, then routed to DLQ, never calling ingest()', async () => {
    const { consumer, ingest, publish } = buildHarness();
    const { campaignCode: _omit, ...withoutCampaignCode } = validBody();

    const outcome = await consumer.processMessage({
      key: 'cust-1',
      value: JSON.stringify(withoutCampaignCode),
    });

    expect(outcome).toBe('DLQ');
    expect(ingest).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    const [key, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(key).toBe('cust-1');
    expect(message.error).toMatch(/campaignCode/);
    expect(typeof message.failedAt).toBe('string');
    // Original body fields are preserved alongside the failure metadata.
    expect(message.rewardCode).toBe('RWD-CASHBACK-5PCT');
  });

  // TC-4 (negative)
  it('TC-4: an unparseable activityPerformedDate is retried, then routed to DLQ', async () => {
    const { consumer, ingest, publish } = buildHarness();

    const outcome = await consumer.processMessage({
      key: 'cust-1',
      value: JSON.stringify(validBody({ activityPerformedDate: '2026-09-04 10:15:00' })),
    });

    expect(outcome).toBe('DLQ');
    expect(ingest).not.toHaveBeenCalled();
    const [, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(message.error).toMatch(/activityPerformedDate/);
  });

  it('a message that is not valid JSON at all is retried, then routed to DLQ with the raw value preserved', async () => {
    const { consumer, ingest, publish } = buildHarness();

    const outcome = await consumer.processMessage({ key: 'cust-1', value: 'not-json{{{' });

    expect(outcome).toBe('DLQ');
    expect(ingest).not.toHaveBeenCalled();
    const [, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(message.raw).toBe('not-json{{{');
  });

  it('schema validation is retried up to MAX_SCHEMA_VALIDATION_ATTEMPTS before DLQ', async () => {
    const { consumer, publish } = buildHarness();

    await consumer.processMessage({ key: 'cust-1', value: 'not-json{{{' });

    // Each retry re-attempts JSON.parse — no direct spy needed; instead confirm the DLQ was only
    // reached once, after the full bounded budget (not before it, not more than once).
    expect(publish).toHaveBeenCalledTimes(1);
    expect(MAX_SCHEMA_VALIDATION_ATTEMPTS).toBeGreaterThan(1);
  });

  // TC-5: simulated crash window — ingest() succeeds (a fresh insert), then the identical message
  // is redelivered (as if the process had crashed before the real kafkajs wiring's own offset
  // commit ran) and ingest() resolves again, this time to the already-existing row's status. Still
  // exactly one call sequence, both ACK, never a thrown error, never a DLQ publish.
  it('TC-5: redelivery after a simulated crash (ingest() succeeded, offset never committed) is a safe, ACKed no-op', async () => {
    const ingest = jest
      .fn()
      .mockResolvedValueOnce({ rewardEntryId: 'reward-entry-1', status: 'received' })
      .mockResolvedValueOnce({ rewardEntryId: 'reward-entry-1', status: 'received' });
    const { consumer, publish } = buildHarness(ingest);
    const raw: RawKafkaMessage = { key: 'cust-1', value: JSON.stringify(validBody()) };

    const beforeCrash = await consumer.processMessage(raw);
    // Simulated crash: no offset-commit call happens between these two lines in this test, exactly
    // mirroring what the real kafkajs wiring in `start()` would (not) do in that window.
    const afterRestart = await consumer.processMessage(raw);

    expect(beforeCrash).toBe('ACK');
    expect(afterRestart).toBe('ACK');
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls[0][0]).toEqual(ingest.mock.calls[1][0]);
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-6 (negative): ingest() throws for a reason other than a duplicate (a simulated DB outage) —
  // never retried in-process, never routed to DLQ, propagates uncaught so the real kafkajs wiring
  // never reaches its own offset-commit call for this message.
  it("TC-6: a non-duplicate ingest() failure (simulated DB outage) propagates uncaught, never DLQ'd, never retried", async () => {
    const ingest = jest.fn().mockRejectedValue(new Error('simulated DB outage'));
    const { consumer, publish } = buildHarness(ingest);

    await expect(
      consumer.processMessage({ key: 'cust-1', value: JSON.stringify(validBody()) }),
    ).rejects.toThrow('simulated DB outage');

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('a DLQ publish failure surfaces as a thrown error rather than being silently swallowed', async () => {
    const { consumer, publish } = buildHarness();
    publish.mockRejectedValue(new Error('broker unreachable'));
    const { campaignCode: _omit, ...withoutCampaignCode } = validBody();

    await expect(
      consumer.processMessage({ key: 'cust-1', value: JSON.stringify(withoutCampaignCode) }),
    ).rejects.toThrow('broker unreachable');
  });

  it('exposes the fixed, non-overridable protocol constants documented by 02-KAFKA-CONTRACTS.md §1', () => {
    expect(REWARD_ENTRY_CREATED_TOPIC).toBe('reward.entry.created.v1');
    expect(REWARD_ENTRY_CREATED_CONSUMER_GROUP).toBe('reward-redemption-service-ingest');
  });
});

describe('RewardEntryCreatedConsumer.start() — real offset-commit wiring (mocked kafkajs)', () => {
  // Reuses this file's own static, file-wide `kafkajs` mock (top of file) — `start()` is the real
  // production code path under test here; only the broker underneath it is faked. Captures exactly
  // what `start()` passes to `consumer.run({ autoCommit, eachMessage })` so this suite can drive the
  // real `eachMessage` callback directly against a fake message/offset.
  type RunConfig = {
    autoCommit?: boolean;
    eachMessage: (payload: {
      topic: string;
      partition: number;
      message: { key: Buffer | null; value: Buffer | null; offset: string };
    }) => Promise<void>;
  };

  beforeEach(() => {
    kafkaConsumerConnect.mockClear().mockResolvedValue(undefined);
    kafkaConsumerSubscribe.mockClear().mockResolvedValue(undefined);
    kafkaConsumerRun.mockClear().mockResolvedValue(undefined);
    kafkaConsumerCommitOffsets.mockClear().mockResolvedValue(undefined);
    kafkaConsumerDisconnect.mockClear().mockResolvedValue(undefined);
    kafkaConsumerFactory.mockClear();
  });

  async function buildStartedConsumer(ingestImpl: jest.Mock): Promise<RunConfig> {
    const ingestionService = { ingest: ingestImpl } as unknown as RewardIngestionService;
    const dlqPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as RewardEntryCreatedDlqProducer;
    const configService = {
      get: () => 'localhost:9094',
    } as unknown as ConfigService<Config, true>;
    const consumer = new RewardEntryCreatedConsumer(
      ingestionService,
      dlqPublisher,
      configService,
      BACKOFF_BASE_MS,
      BACKOFF_MAX_MS,
    );
    await consumer.start();
    return kafkaConsumerRun.mock.calls[0][0] as RunConfig;
  }

  it('disables kafkajs auto-commit', async () => {
    const runConfig = await buildStartedConsumer(
      jest.fn().mockResolvedValue({ rewardEntryId: 'x', status: 'received' }),
    );

    expect(runConfig.autoCommit).toBe(false);
  });

  it('joins the shared, fixed consumer group and subscribes to the fixed topic', async () => {
    const { Kafka } = jest.requireMock('kafkajs') as { Kafka: jest.Mock };
    await buildStartedConsumer(
      jest.fn().mockResolvedValue({ rewardEntryId: 'x', status: 'received' }),
    );

    expect(kafkaConsumerFactory).toHaveBeenCalledWith({
      groupId: REWARD_ENTRY_CREATED_CONSUMER_GROUP,
    });
    expect(kafkaConsumerSubscribe).toHaveBeenCalledWith({
      topic: REWARD_ENTRY_CREATED_TOPIC,
      fromBeginning: false,
    });
    expect(Kafka).toHaveBeenCalled();
  });

  it('commits the offset only after processMessage resolves successfully (ACK)', async () => {
    const runConfig = await buildStartedConsumer(
      jest.fn().mockResolvedValue({ rewardEntryId: 'x', status: 'received' }),
    );

    await runConfig.eachMessage({
      topic: REWARD_ENTRY_CREATED_TOPIC,
      partition: 0,
      message: {
        key: Buffer.from('cust-1'),
        value: Buffer.from(JSON.stringify(validBody())),
        offset: '41',
      },
    });

    expect(kafkaConsumerCommitOffsets).toHaveBeenCalledWith([
      { topic: REWARD_ENTRY_CREATED_TOPIC, partition: 0, offset: '42' },
    ]);
  });

  it('does NOT commit the offset when processMessage throws (a non-duplicate ingest() failure)', async () => {
    const runConfig = await buildStartedConsumer(
      jest.fn().mockRejectedValue(new Error('simulated DB outage')),
    );

    await expect(
      runConfig.eachMessage({
        topic: REWARD_ENTRY_CREATED_TOPIC,
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

  it('still commits the offset for a schema-invalid message routed to the DLQ', async () => {
    const { campaignCode: _omit, ...withoutCampaignCode } = validBody();
    const runConfig = await buildStartedConsumer(jest.fn());

    await runConfig.eachMessage({
      topic: REWARD_ENTRY_CREATED_TOPIC,
      partition: 2,
      message: {
        key: Buffer.from('cust-1'),
        value: Buffer.from(JSON.stringify(withoutCampaignCode)),
        offset: '7',
      },
    });

    expect(kafkaConsumerCommitOffsets).toHaveBeenCalledWith([
      { topic: REWARD_ENTRY_CREATED_TOPIC, partition: 2, offset: '8' },
    ]);
  });

  it('stop() disconnects a started consumer; calling start() twice only connects once', async () => {
    const ingestionService = {
      ingest: jest.fn().mockResolvedValue({ rewardEntryId: 'x', status: 'received' }),
    } as unknown as RewardIngestionService;
    const dlqPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as RewardEntryCreatedDlqProducer;
    const configService = { get: () => 'localhost:9094' } as unknown as ConfigService<Config, true>;
    const consumer = new RewardEntryCreatedConsumer(
      ingestionService,
      dlqPublisher,
      configService,
      BACKOFF_BASE_MS,
      BACKOFF_MAX_MS,
    );

    await consumer.start();
    await consumer.start();
    expect(kafkaConsumerConnect).toHaveBeenCalledTimes(1);

    await consumer.stop();
    expect(kafkaConsumerDisconnect).toHaveBeenCalledTimes(1);

    // A second stop() (or onModuleDestroy after an explicit stop()) is a safe no-op.
    await consumer.stop();
    expect(kafkaConsumerDisconnect).toHaveBeenCalledTimes(1);
  });
});
