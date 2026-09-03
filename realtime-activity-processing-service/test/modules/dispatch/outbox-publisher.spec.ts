/**
 * T-RAP-034. `OutboxPublisherService` (tiers 1-2, `05-PROCESSING-PIPELINE.md` §7) against fakes for
 * every collaborator — deterministic, no real broker/gRPC server needed (`reward-grpc-fallback.spec.ts`
 * covers the real wire client separately; `dispatch-chain.e2e-spec.ts` covers the whole
 * chain against a genuinely-unreachable broker). Same "assert the observable property" discipline
 * as every prior fake-collaborator suite in this project (`activity-ingest.consumer.spec.ts`):
 * every assertion below checks what was actually called/persisted, not an internal implementation
 * string.
 *
 * `EncryptionService` is the one **real** collaborator here (not faked) — TC-2/TC-3/TC-4/TC-5 all
 * depend on `row.payload.customerIdEncrypted` actually decrypting to the same `customerId` the test
 * encrypted, proving R4's boundary end to end, not just that some decrypt method was called.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import type { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import type { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import type { RewardDispatchMaxRetryResolver } from '@/modules/dispatch/dispatch.config';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import type { RewardDispatchRetryRepository } from '@/modules/dispatch/reward-dispatch-retry.repository';
import type { RewardKafkaProducerClient } from '@/modules/dispatch/reward-kafka-producer.client';
import type { RewardGrpcFallbackClient } from '@/modules/dispatch/reward-grpc-fallback.client';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/structured-logger';
import type { LogRedactorService } from '@/modules/encryption/log-redactor.service';

/** Same hand-rolled fake `structured-logger.spec.ts` itself uses for this exact collaborator — a
 * real `StructuredLoggerFactory`/`StructuredLogger`, not a mock, over a no-op redactor. */
function fakeLoggerFactory(): StructuredLoggerFactory {
  return new StructuredLoggerFactory({
    redact: (_field: string, value: string) => value,
  } as unknown as LogRedactorService);
}

const AES_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const THRESHOLD = 3;

function fakePendingRow(overrides: Partial<Record<string, unknown>> = {}) {
  const customerId = (overrides.__customerId as string) ?? 'CUST-42';
  return {
    id: 'outbox-row-1',
    rewardEntryId: 'reward-entry-1',
    topic: 'reward.entry.created.v1',
    attempts: 0,
    createdAt: new Date(),
    payload: {
      id: 'reward-entry-1',
      correlationId: 'corr-1',
      tenantId: 1,
      customerIdEncrypted: encryption.encrypt(customerId),
      customerIdType: 'INTERNAL_ID',
      activityPerformedDate: new Date().toISOString(),
      transactionType: null,
      activityCode: 'PURCHASE',
      activityType: 'TRANSACTION',
      activityCategory: 'RETAIL',
      activityValue: '10.0000',
      activityValueUnit: 'MYR',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 'Online purchase',
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      merchantCode: null,
      rewardCode: 'RWD1',
      rewardCategory: 'cashback',
      rewardValue: '10.00',
      rewardValueUnit: 'MYR',
      rewardEntryDate: new Date().toISOString(),
      completionCycle: 1,
    },
    ...overrides,
  };
}

interface Fakes {
  outboxRepository: RewardEntryOutboxRepository & {
    findPendingBatch: jest.Mock;
    incrementAttempts: jest.Mock;
    markPublished: jest.Mock;
    markFailed: jest.Mock;
  };
  rewardEntryRepository: RewardEntryRepository & {
    markDispatched: jest.Mock;
    recordDispatchAttemptFailure: jest.Mock;
    markDispatchFailed: jest.Mock;
  };
  retryRepository: RewardDispatchRetryRepository & { create: jest.Mock };
  kafkaProducer: RewardKafkaProducerClient & { publish: jest.Mock };
  grpcFallback: RewardGrpcFallbackClient & { submitRewardEntry: jest.Mock };
  configResolver: RewardDispatchMaxRetryResolver;
}

function buildFakes(pendingRows: ReturnType<typeof fakePendingRow>[]): Fakes {
  return {
    outboxRepository: {
      findPendingBatch: jest.fn().mockResolvedValue(pendingRows),
      incrementAttempts: jest.fn().mockResolvedValue(undefined),
      markPublished: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as Fakes['outboxRepository'],
    rewardEntryRepository: {
      markDispatched: jest.fn().mockResolvedValue(undefined),
      recordDispatchAttemptFailure: jest.fn().mockResolvedValue(undefined),
      markDispatchFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as Fakes['rewardEntryRepository'],
    retryRepository: {
      create: jest.fn().mockResolvedValue({ id: 'retry-row-1' }),
    } as unknown as Fakes['retryRepository'],
    kafkaProducer: {
      publish: jest.fn(),
    } as unknown as Fakes['kafkaProducer'],
    grpcFallback: {
      submitRewardEntry: jest.fn(),
    } as unknown as Fakes['grpcFallback'],
    configResolver: { getRewardDispatchMaxRetryAttempts: () => THRESHOLD },
  };
}

function buildService(
  fakes: Fakes,
  metrics: MetricsService = new MetricsService(),
): OutboxPublisherService {
  return new OutboxPublisherService(
    fakes.outboxRepository,
    fakes.rewardEntryRepository,
    fakes.retryRepository,
    fakes.kafkaProducer,
    fakes.grpcFallback,
    encryption,
    fakes.configResolver,
    metrics,
    fakeLoggerFactory(),
    500,
    20,
    false,
  );
}

describe('OutboxPublisherService', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('TC-2: Kafka publish succeeds on first attempt -> row marked PUBLISHED, reward_entry dispatched', async () => {
    const row = fakePendingRow({ __customerId: 'CUST-2', attempts: 0 });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const metrics = new MetricsService();
    const service = buildService(fakes, metrics);

    await service.runOnce();

    expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
    const [topic, key, message] = fakes.kafkaProducer.publish.mock.calls[0];
    expect(topic).toBe('reward.entry.created.v1');
    expect(key).toBe('CUST-2');
    expect(message.customerId).toBe('CUST-2');
    expect(message).not.toHaveProperty('customerIdEncrypted');
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
    expect(fakes.rewardEntryRepository.markDispatched).toHaveBeenCalledWith('reward-entry-1');
    expect(fakes.grpcFallback.submitRewardEntry).not.toHaveBeenCalled();
    // T-RAP-059: tier 1 (Kafka) success.
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'kafka' })).toBe(1);
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'grpc' })).toBe(0);
  });

  it('TC-3: Kafka fails below threshold -> attempts incremented, stays PENDING, gRPC not tried yet', async () => {
    const row = fakePendingRow({ attempts: 0 });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('broker unreachable'));
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.outboxRepository.incrementAttempts).toHaveBeenCalledWith('outbox-row-1');
    expect(fakes.rewardEntryRepository.recordDispatchAttemptFailure).toHaveBeenCalledWith(
      'reward-entry-1',
      expect.stringContaining('broker unreachable'),
    );
    expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalled();
    expect(fakes.grpcFallback.submitRewardEntry).not.toHaveBeenCalled();
  });

  it('TC-3: attempts already at the configured threshold -> falls through to gRPC fallback, Kafka not retried', async () => {
    const row = fakePendingRow({ attempts: THRESHOLD });
    const fakes = buildFakes([row]);
    fakes.grpcFallback.submitRewardEntry.mockResolvedValue({
      rewardEntryId: 'reward-entry-1',
      status: 'accepted',
    });
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.grpcFallback.submitRewardEntry).toHaveBeenCalledTimes(1);
  });

  it('TC-4: gRPC fallback succeeds after Kafka repeatedly failed -> marked delivered (outbox PUBLISHED, reward_entry dispatched)', async () => {
    const row = fakePendingRow({ __customerId: 'CUST-4', attempts: THRESHOLD });
    const fakes = buildFakes([row]);
    fakes.grpcFallback.submitRewardEntry.mockResolvedValue({
      rewardEntryId: 'reward-entry-1',
      status: 'accepted',
    });
    const metrics = new MetricsService();
    const service = buildService(fakes, metrics);

    await service.runOnce();

    const [payload] = fakes.grpcFallback.submitRewardEntry.mock.calls[0];
    expect(payload.customerId).toBe('CUST-4');
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
    expect(fakes.rewardEntryRepository.markDispatched).toHaveBeenCalledWith('reward-entry-1');
    // Outbox row is marked PUBLISHED, the same terminal state Kafka success produces — the next
    // `findPendingBatch` (WHERE status = 'PENDING') simply never returns this row again, proven
    // for real against Postgres by `reward-entry.repository.spec.ts`'s own outbox coverage.
    expect(fakes.outboxRepository.markFailed).not.toHaveBeenCalled();
    // T-RAP-059: tier 2 (gRPC) success, never tier 1 for this row (Kafka was never attempted at
    // attempts >= threshold).
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'grpc' })).toBe(1);
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'kafka' })).toBe(0);
  });

  it('TC-5: both Kafka and gRPC fail -> reward_dispatch_retry row created, outbox FAILED, reward_entry dispatch_status failed', async () => {
    const row = fakePendingRow({ attempts: THRESHOLD });
    const fakes = buildFakes([row]);
    fakes.grpcFallback.submitRewardEntry.mockRejectedValue(
      new Error('redemption-service unreachable'),
    );
    const metrics = new MetricsService();
    const service = buildService(fakes, metrics);

    await service.runOnce();

    // T-RAP-059: no tier "succeeded" -> no reward_dispatch_tier_total increment at all.
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'kafka' })).toBe(0);
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'grpc' })).toBe(0);
    expect(fakes.outboxRepository.markFailed).toHaveBeenCalledWith('outbox-row-1');
    expect(fakes.rewardEntryRepository.markDispatchFailed).toHaveBeenCalledWith(
      'reward-entry-1',
      expect.stringContaining('redemption-service unreachable'),
    );
    expect(fakes.retryRepository.create).toHaveBeenCalledWith({
      rewardEntryId: 'reward-entry-1',
      failureReason: expect.stringContaining('redemption-service unreachable'),
    });
    expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  it('an empty batch is a pure no-op — no Kafka/gRPC call, no repository write', async () => {
    const fakes = buildFakes([]);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.grpcFallback.submitRewardEntry).not.toHaveBeenCalled();
    expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  it('processes multiple pending rows sequentially, each independently', async () => {
    const rowA = fakePendingRow({
      id: 'outbox-row-a',
      rewardEntryId: 'reward-entry-a',
      attempts: 0,
    });
    const rowB = fakePendingRow({
      id: 'outbox-row-b',
      rewardEntryId: 'reward-entry-b',
      attempts: 0,
    });
    const fakes = buildFakes([rowA, rowB]);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(2);
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-a');
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-b');
  });

  it('start()/stop() manage a real interval without throwing, and runOnce() overlap collapses into one in-flight cycle', async () => {
    const row = fakePendingRow({ attempts: 0 });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const service = buildService(fakes);

    // Two synchronous, back-to-back calls: `cycleInFlight` is set (synchronously, before either
    // promise's first `await` settles) by the first call, so the second must observe it already
    // set and return that same in-flight promise rather than starting a second, overlapping fetch.
    const first = service.runOnce();
    const second = service.runOnce();
    await Promise.all([first, second]);

    expect(fakes.outboxRepository.findPendingBatch).toHaveBeenCalledTimes(1);

    service.start();
    service.start();
    service.stop();
    service.stop();
  });
});
