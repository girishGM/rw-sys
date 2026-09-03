/**
 * T-RAP-034. `RewardDispatchRetryWorker` (tier 3, `05-PROCESSING-PIPELINE.md` §7 point 3) against
 * fakes for every collaborator — same discipline `outbox-publisher.spec.ts` documents for its
 * sibling. `EncryptionService` is again the one real collaborator (R4's decrypt-at-publish
 * boundary must actually round-trip, not just "some decrypt method was called").
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import type { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import type { RewardEntryRow } from '@/database/models/reward-entry.model';
import type { RewardDispatchRetryRow } from '@/database/models/reward-dispatch-retry.model';
import type { RewardDispatchMaxRetryResolver } from '@/modules/dispatch/dispatch.config';
import { RewardDispatchRetryWorker } from '@/modules/dispatch/reward-dispatch-retry.worker';
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

const AES_KEY_B64 = Buffer.alloc(32, 3).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 5).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const THRESHOLD = 3;

function fakeRewardEntryRow(overrides: Partial<RewardEntryRow> = {}): RewardEntryRow {
  return {
    id: 'reward-entry-1',
    correlation_id: 'corr-1',
    tenant_id: 1,
    customer_id_encrypted: encryption.encrypt('CUST-77'),
    customer_id_hash: 'h'.repeat(64),
    customer_id_type: 'INTERNAL_ID',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'PURCHASE',
    activity_type: 'TRANSACTION',
    activity_category: 'RETAIL',
    activity_value: '10.0000',
    activity_value_unit: 'MYR',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 'Online purchase',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'cashback',
    reward_value: '10.0000',
    reward_value_unit: 'MYR',
    reward_entry_date: new Date(),
    completion_cycle: 1,
    dispatch_status: 'failed',
    dispatch_attempts: 2,
    last_dispatch_error: 'both tiers failed',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function fakeRetryRow(overrides: Partial<RewardDispatchRetryRow> = {}): RewardDispatchRetryRow {
  return {
    id: 'retry-row-1',
    reward_entry_id: 'reward-entry-1',
    kafka_attempts: 0,
    grpc_attempts: 0,
    failure_reason: 'both tiers failed',
    status: 'pending',
    next_retry_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

interface Fakes {
  retryRepository: RewardDispatchRetryRepository & {
    findDueBatch: jest.Mock;
    recordDualAttemptFailure: jest.Mock;
    markResolved: jest.Mock;
    markExhausted: jest.Mock;
  };
  rewardEntryRepository: RewardEntryRepository & { findById: jest.Mock; markDispatched: jest.Mock };
  kafkaProducer: RewardKafkaProducerClient & { publish: jest.Mock };
  grpcFallback: RewardGrpcFallbackClient & { submitRewardEntry: jest.Mock };
  configResolver: RewardDispatchMaxRetryResolver;
}

function buildFakes(dueRows: RewardDispatchRetryRow[], rewardEntry: RewardEntryRow | null): Fakes {
  return {
    retryRepository: {
      findDueBatch: jest.fn().mockResolvedValue(dueRows),
      recordDualAttemptFailure: jest.fn().mockResolvedValue(undefined),
      markResolved: jest.fn().mockResolvedValue(undefined),
      markExhausted: jest.fn().mockResolvedValue(undefined),
    } as unknown as Fakes['retryRepository'],
    rewardEntryRepository: {
      findById: jest.fn().mockResolvedValue(rewardEntry),
      markDispatched: jest.fn().mockResolvedValue(undefined),
    } as unknown as Fakes['rewardEntryRepository'],
    kafkaProducer: { publish: jest.fn() } as unknown as Fakes['kafkaProducer'],
    grpcFallback: { submitRewardEntry: jest.fn() } as unknown as Fakes['grpcFallback'],
    configResolver: { getRewardDispatchMaxRetryAttempts: () => THRESHOLD },
  };
}

function buildWorker(
  fakes: Fakes,
  metrics: MetricsService = new MetricsService(),
): RewardDispatchRetryWorker {
  return new RewardDispatchRetryWorker(
    fakes.retryRepository,
    fakes.rewardEntryRepository,
    fakes.kafkaProducer,
    fakes.grpcFallback,
    encryption,
    fakes.configResolver,
    metrics,
    fakeLoggerFactory(),
    2000,
    20,
    1000,
    60_000,
    false,
  );
}

describe('RewardDispatchRetryWorker', () => {
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

  it('TC-6: Kafka succeeds on this attempt -> resolved, reward_entry marked dispatched, gRPC never tried', async () => {
    const rewardEntry = fakeRewardEntryRow();
    const fakes = buildFakes([fakeRetryRow()], rewardEntry);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const metrics = new MetricsService();
    const worker = buildWorker(fakes, metrics);

    await worker.runOnce();

    const [topic, key, message] = fakes.kafkaProducer.publish.mock.calls[0];
    expect(topic).toBe('reward.entry.created.v1');
    expect(key).toBe('CUST-77');
    expect(message.customerId).toBe('CUST-77');
    expect(fakes.grpcFallback.submitRewardEntry).not.toHaveBeenCalled();
    expect(fakes.retryRepository.markResolved).toHaveBeenCalledWith('retry-row-1');
    expect(fakes.rewardEntryRepository.markDispatched).toHaveBeenCalledWith('reward-entry-1');
    // T-RAP-059: tier 3 (retry-table) success — this worker's own single successful-dispatch call
    // site, regardless of which of its two channels (Kafka here) actually delivered.
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'retry_table' })).toBe(1);
  });

  it('TC-6 (gRPC leg): Kafka fails but gRPC succeeds this attempt -> resolved, reward_entry dispatched', async () => {
    const rewardEntry = fakeRewardEntryRow();
    const fakes = buildFakes([fakeRetryRow()], rewardEntry);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('still down'));
    fakes.grpcFallback.submitRewardEntry.mockResolvedValue({
      rewardEntryId: 'reward-entry-1',
      status: 'accepted',
    });
    const worker = buildWorker(fakes);

    await worker.runOnce();

    expect(fakes.grpcFallback.submitRewardEntry).toHaveBeenCalledTimes(1);
    expect(fakes.retryRepository.markResolved).toHaveBeenCalledWith('retry-row-1');
    expect(fakes.rewardEntryRepository.markDispatched).toHaveBeenCalledWith('reward-entry-1');
  });

  it('both channels fail again, below the retry ceiling -> dual attempt counters bumped, stays pending with backoff', async () => {
    const rewardEntry = fakeRewardEntryRow();
    const dueRow = fakeRetryRow({ kafka_attempts: 0, grpc_attempts: 0 });
    const fakes = buildFakes([dueRow], rewardEntry);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('kafka down'));
    fakes.grpcFallback.submitRewardEntry.mockRejectedValue(new Error('grpc down'));
    const metrics = new MetricsService();
    const worker = buildWorker(fakes, metrics);

    await worker.runOnce();

    expect(fakes.retryRepository.recordDualAttemptFailure).toHaveBeenCalledWith(
      'retry-row-1',
      expect.stringContaining('kafka down'),
      expect.any(Date),
    );
    expect(fakes.retryRepository.markExhausted).not.toHaveBeenCalled();
    expect(fakes.retryRepository.markResolved).not.toHaveBeenCalled();
    // T-RAP-059: neither channel succeeded -> no tier increment.
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'retry_table' })).toBe(0);
  });

  it('TC-7: both channels fail on the attempt that reaches the configured ceiling -> exhausted, still queryable', async () => {
    const rewardEntry = fakeRewardEntryRow();
    // attemptsAfter = max(kafka_attempts, grpc_attempts) + 1 >= THRESHOLD(3) when both are 2.
    const dueRow = fakeRetryRow({ kafka_attempts: 2, grpc_attempts: 2 });
    const fakes = buildFakes([dueRow], rewardEntry);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('kafka down'));
    fakes.grpcFallback.submitRewardEntry.mockRejectedValue(new Error('grpc down'));
    const worker = buildWorker(fakes);

    await worker.runOnce();

    expect(fakes.retryRepository.markExhausted).toHaveBeenCalledWith(
      'retry-row-1',
      expect.stringContaining('kafka down'),
    );
    expect(fakes.retryRepository.recordDualAttemptFailure).not.toHaveBeenCalled();
    expect(fakes.retryRepository.markResolved).not.toHaveBeenCalled();
  });

  it('a due row whose reward_entry_id no longer resolves is skipped, not thrown', async () => {
    const fakes = buildFakes([fakeRetryRow()], null);
    const worker = buildWorker(fakes);

    await expect(worker.runOnce()).resolves.toBeUndefined();
    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.grpcFallback.submitRewardEntry).not.toHaveBeenCalled();
  });

  it('an empty due batch is a pure no-op', async () => {
    const fakes = buildFakes([], null);
    const worker = buildWorker(fakes);

    await worker.runOnce();

    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.retryRepository.findDueBatch).toHaveBeenCalledTimes(1);
  });

  it('start()/stop() manage a real interval without throwing, runOnce() overlap collapses into one in-flight cycle', async () => {
    const fakes = buildFakes([], null);
    const worker = buildWorker(fakes);

    const first = worker.runOnce();
    const second = worker.runOnce();
    await Promise.all([first, second]);
    expect(fakes.retryRepository.findDueBatch).toHaveBeenCalledTimes(1);

    worker.start();
    worker.start();
    worker.stop();
    worker.stop();
  });
});
