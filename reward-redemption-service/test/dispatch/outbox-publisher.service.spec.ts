/**
 * T-RR-034/T-RR-035 — `OutboxPublisherService`'s full tier-selection algorithm (Kafka/REST
 * primary-then-fallback, broker-unreachable immediate fallthrough, escalation to
 * `reward_tracking_dispatch_retry`) against fakes for every collaborator — deterministic, no real
 * broker/HTTP call needed (T-RR-034's own Verification step 2 covers the real Kafka wire path
 * against a local Redpanda separately; T-RR-035's own Verification step 2 covers the real
 * "Kafka down -> REST fires" path the same way). Same "assert the observable property" discipline
 * as RAP's own `outbox-publisher.spec.ts`: every assertion below checks what was actually
 * called/persisted, never an internal implementation string.
 *
 * `EncryptionService` is the one **real** collaborator here (not faked) — several cases depend on
 * `row.payload.customerIdEncrypted` actually decrypting to the same `customerId` this suite
 * encrypted, proving R8's boundary end to end, not just that some decrypt method was called.
 * `DispatchMetricsService` is likewise real (not faked), so the tier-metric assertions check a
 * real counter value.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import { DispatchMetricsService } from '@/modules/dispatch/dispatch-metrics.service';
import { KafkaBrokerUnreachableError } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import type { RewardTrackingGrpcClient } from '@/modules/dispatch/reward-tracking-grpc.client';
import type {
  DispatchChannelResolverService,
  ResolvedDispatchChannel,
} from '@/modules/dispatch/dispatch-channel-resolver.service';
import type {
  OutboxPendingRow,
  RewardTrackingOutboxRepository,
} from '@/modules/dispatch/reward-tracking-outbox.repository';
import type { RewardTrackingKafkaProducerClient } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import type { RewardTrackingRestClient } from '@/modules/dispatch/reward-tracking-rest.client';
import type { RewardTrackingDispatchRetryRepository } from '@/modules/dispatch/reward-tracking-dispatch-retry.repository';
import type { DispatchServiceConfigResolver } from '@/modules/dispatch/dispatch.config';

const AES_KEY_B64 = Buffer.alloc(32, 3).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 5).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const THRESHOLD = 3;
// T-INT-051.
const PRE_DISPATCH_POISON_THRESHOLD = 3;
const AVAILABLE_KAFKA_PRIMARY: ResolvedDispatchChannel = {
  primaryChannel: 'KAFKA',
  fallbackChannel: 'REST',
  kafkaEnabled: true,
  restEnabled: true,
  grpcEnabled: false,
};
const AVAILABLE_REST_PRIMARY: ResolvedDispatchChannel = {
  primaryChannel: 'REST',
  fallbackChannel: 'KAFKA',
  kafkaEnabled: true,
  restEnabled: true,
  grpcEnabled: false,
};

function fakePendingRow(
  overrides: Partial<OutboxPendingRow> & { __customerId?: string } = {},
): OutboxPendingRow {
  const customerId = overrides.__customerId ?? 'CUST-42';
  const base: OutboxPendingRow = {
    id: 'outbox-row-1',
    rewardEntryId: 'reward-entry-1',
    topic: 'reward.redemption.completed.v1',
    attempts: 0,
    createdAt: new Date(),
    rewardCode: 'RWD1',
    trackerCode: 'TRK1',
    campaignCode: 'CAMP1',
    tenantId: 1,
    payload: {
      rewardEntryId: 'reward-entry-1',
      tenantId: 1,
      tenantCode: 'TEN-MY',
      countryCode: 'MY',
      customerIdEncrypted: encryption.encrypt(customerId),
      campaignCode: 'CAMP1',
      rewardCode: 'RWD1',
      rewardCategory: 'CASHBACK',
      rewardValue: '2.5000',
      rewardValueUnit: 'MYR',
      externalSystemCode: 'PROMO_CODE_SERVICE',
      externalReferenceId: 'PC-abc123',
      redeemedAt: new Date().toISOString(),
      correlationId: 'corr-1',
      // T-RR-062.
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      merchantCode: null,
      expiresAt: null,
      rewardKind: null,
      promoCodeConfigId: null,
      promoCodeConfigVersionNo: null,
    },
  };
  return { ...base, ...overrides };
}

interface Fakes {
  outboxRepository: RewardTrackingOutboxRepository & {
    findPendingBatch: jest.Mock;
    incrementAttempts: jest.Mock;
    markPublished: jest.Mock;
    markFailed: jest.Mock;
    // T-INT-051.
    recordPreDispatchFailure: jest.Mock;
  };
  dispatchResolver: DispatchChannelResolverService & { resolve: jest.Mock };
  kafkaProducer: RewardTrackingKafkaProducerClient & { publish: jest.Mock };
  restClient: RewardTrackingRestClient & { dispatch: jest.Mock };
  grpcClient: RewardTrackingGrpcClient & { dispatch: jest.Mock };
  retryRepository: RewardTrackingDispatchRetryRepository & { create: jest.Mock };
  configResolver: DispatchServiceConfigResolver;
}

function buildFakes(
  pendingRows: OutboxPendingRow[],
  resolved: ResolvedDispatchChannel = AVAILABLE_KAFKA_PRIMARY,
): Fakes {
  // T-INT-051: mirrors the real repository's own stateful, per-row increment-and-maybe-poison
  // behaviour (`recordPreDispatchFailure`) closely enough for these fakes-only unit tests to drive
  // a row across the poison threshold over several `runOnce()` calls, exactly like the real
  // `attempts` column does across real poll cycles.
  const preDispatchFailureCounts = new Map<string, number>();
  return {
    outboxRepository: {
      findPendingBatch: jest.fn().mockResolvedValue(pendingRows),
      incrementAttempts: jest.fn().mockResolvedValue(undefined),
      markPublished: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      recordPreDispatchFailure: jest.fn(
        async (id: string, _lastError: string, maxAttemptsBeforePoison: number) => {
          const attempts = (preDispatchFailureCounts.get(id) ?? 0) + 1;
          preDispatchFailureCounts.set(id, attempts);
          return { attempts, poisoned: attempts >= maxAttemptsBeforePoison };
        },
      ),
    } as unknown as Fakes['outboxRepository'],
    dispatchResolver: {
      resolve: jest.fn().mockResolvedValue(resolved),
    } as unknown as Fakes['dispatchResolver'],
    kafkaProducer: {
      publish: jest.fn(),
    } as unknown as Fakes['kafkaProducer'],
    restClient: {
      dispatch: jest.fn(),
    } as unknown as Fakes['restClient'],
    grpcClient: {
      dispatch: jest.fn(),
    } as unknown as Fakes['grpcClient'],
    retryRepository: {
      create: jest.fn().mockResolvedValue(undefined),
    } as unknown as Fakes['retryRepository'],
    configResolver: {
      resolve: jest.fn(async (key: string) => {
        if (key === 'dispatch.kafka.attemptsBeforeFallback') {
          return THRESHOLD;
        }
        if (key === 'dispatch.outbox.pollIntervalSeconds') {
          return 5;
        }
        // T-INT-051.
        if (key === 'dispatch.outbox.maxPreDispatchFailures') {
          return PRE_DISPATCH_POISON_THRESHOLD;
        }
        throw new Error(`unexpected service_config key "${key}" resolved in this test`);
      }) as unknown as DispatchServiceConfigResolver['resolve'],
    },
  };
}

function buildService(
  fakes: Fakes,
  metrics: DispatchMetricsService = new DispatchMetricsService(),
): OutboxPublisherService {
  return new OutboxPublisherService(
    fakes.outboxRepository,
    fakes.dispatchResolver,
    encryption,
    fakes.kafkaProducer,
    metrics,
    fakes.configResolver,
    fakes.restClient,
    fakes.retryRepository,
    20,
    false,
    fakes.grpcClient,
  );
}

describe('T-RR-034/T-RR-035 — OutboxPublisherService', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('TC-1/TC-4/TC-5/TC-7: Kafka primary available -> publishes the exact contract shape, key = customerId, row marked PUBLISHED', async () => {
    const row = fakePendingRow({ __customerId: 'CUST-1' });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
    expect(fakes.restClient.dispatch).not.toHaveBeenCalled();
    const [topic, key, message] = fakes.kafkaProducer.publish.mock.calls[0];
    expect(topic).toBe('reward.redemption.completed.v1');
    // TC-7: partition key equals customerId.
    expect(key).toBe('CUST-1');
    // TC-5: real decrypted value present.
    expect(message.customerId).toBe('CUST-1');
    // TC-4: exact 02-KAFKA-CONTRACTS.md §2 shape — customerIdEncrypted never leaks into the wire message.
    expect(message).not.toHaveProperty('customerIdEncrypted');
    expect(message).toEqual({
      rewardEntryId: 'reward-entry-1',
      tenantId: 1,
      tenantCode: 'TEN-MY',
      countryCode: 'MY',
      campaignCode: 'CAMP1',
      rewardCode: 'RWD1',
      rewardCategory: 'CASHBACK',
      rewardValue: '2.5000',
      rewardValueUnit: 'MYR',
      externalSystemCode: 'PROMO_CODE_SERVICE',
      externalReferenceId: 'PC-abc123',
      redeemedAt: row.payload.redeemedAt,
      correlationId: 'corr-1',
      customerId: 'CUST-1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      merchantCode: null,
      expiresAt: null,
      rewardKind: null,
      promoCodeConfigId: null,
      promoCodeConfigVersionNo: null,
    });
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
    expect(fakes.outboxRepository.incrementAttempts).not.toHaveBeenCalled();
  });

  it('T-RR-035 TC-1: resolved primary is REST, REST call succeeds -> row delivered, no Kafka attempt made', async () => {
    const row = fakePendingRow({ __customerId: 'CUST-REST' });
    const fakes = buildFakes([row], AVAILABLE_REST_PRIMARY);
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const metrics = new DispatchMetricsService();
    const service = buildService(fakes, metrics);

    await service.runOnce();

    expect(fakes.restClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.restClient.dispatch.mock.calls[0][0]).toMatchObject({ customerId: 'CUST-REST' });
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
    expect(metrics.getDispatchTierCount('rest')).toBe(1);
  });

  it('T-RR-035 TC-2: Kafka primary + broker unreachable -> immediate REST attempt, no wait for Kafka backoff', async () => {
    const row = fakePendingRow({ attempts: 0 });
    const fakes = buildFakes([row], AVAILABLE_KAFKA_PRIMARY);
    fakes.kafkaProducer.publish.mockRejectedValue(
      new KafkaBrokerUnreachableError(new Error('ECONNREFUSED')),
    );
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
    expect(fakes.restClient.dispatch).toHaveBeenCalledTimes(1);
    // Bypassed the normal multi-cycle threshold entirely — never left PENDING via incrementAttempts.
    expect(fakes.outboxRepository.incrementAttempts).not.toHaveBeenCalled();
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
  });

  it('T-RR-035 TC-3/TC-4: REST 200 {"status":"applied"|"duplicate"} is success; a REST failure is treated like a Kafka publish failure', async () => {
    const successRow = fakePendingRow({
      id: 'row-s',
      rewardEntryId: 'entry-s',
      attempts: THRESHOLD - 1,
    });
    const successFakes = buildFakes([successRow], AVAILABLE_KAFKA_PRIMARY);
    successFakes.kafkaProducer.publish.mockRejectedValue(new Error('per-message failure'));
    successFakes.restClient.dispatch.mockResolvedValue(undefined);
    await buildService(successFakes).runOnce();
    expect(successFakes.outboxRepository.markPublished).toHaveBeenCalledWith('row-s');

    const failRow = fakePendingRow({
      id: 'row-f',
      rewardEntryId: 'entry-f',
      attempts: THRESHOLD - 1,
    });
    const failFakes = buildFakes([failRow], AVAILABLE_KAFKA_PRIMARY);
    failFakes.kafkaProducer.publish.mockRejectedValue(new Error('per-message failure'));
    failFakes.restClient.dispatch.mockRejectedValue(
      new Error('reward-tracking-service REST call failed with HTTP status 500'),
    );
    await buildService(failFakes).runOnce();
    expect(failFakes.outboxRepository.markFailed).toHaveBeenCalledWith('row-f');
    expect(failFakes.retryRepository.create).toHaveBeenCalledTimes(1);
  });

  it('T-RR-035 TC-5: both Kafka (budget exhausted) and the immediate REST attempt fail -> reward_tracking_dispatch_retry row written, outbox row marked FAILED', async () => {
    const row = fakePendingRow({ attempts: THRESHOLD - 1, __customerId: 'CUST-5' });
    const fakes = buildFakes([row], AVAILABLE_KAFKA_PRIMARY);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('persistent per-message failure'));
    fakes.restClient.dispatch.mockRejectedValue(new Error('reward-tracking-service unreachable'));
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.retryRepository.create).toHaveBeenCalledTimes(1);
    const createArg = fakes.retryRepository.create.mock.calls[0][0];
    expect(createArg.rewardEntryId).toBe('reward-entry-1');
    expect(createArg.payload).toEqual(row.payload);
    expect(createArg.lastError).toEqual(expect.any(String));
    expect(fakes.outboxRepository.markFailed).toHaveBeenCalledWith('outbox-row-1');
    expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  it('T-RR-035 TC-10: any dispatch failure leaves the entry-derived payload fields (redeemedAt/externalReferenceId/rewardEntryId) byte-identical on the row written to the retry table', async () => {
    const row = fakePendingRow();
    row.payload.externalReferenceId = 'PC-untouched-123';
    const originalPayload = { ...row.payload };
    const fakes = buildFakes([row], AVAILABLE_KAFKA_PRIMARY);
    fakes.kafkaProducer.publish.mockRejectedValue(
      new KafkaBrokerUnreachableError(new Error('down')),
    );
    fakes.restClient.dispatch.mockRejectedValue(new Error('also down'));
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.outboxRepository.markFailed).toHaveBeenCalledWith('outbox-row-1');
    const createArg = fakes.retryRepository.create.mock.calls[0][0];
    // The row handed to the retry table carries the exact same `redeemedAt`/`externalReferenceId`/
    // `rewardEntryId` this poller was given — no dispatch-tier failure ever rewrites any
    // redemption-derived field, only outbox/retry bookkeeping columns.
    expect(createArg.payload).toEqual(originalPayload);
  });

  it('T-RR-035 TC-11: customerId in the REST payload is the real decrypted value, never logged', async () => {
    const row = fakePendingRow({ __customerId: 'CUST-SECRET-11' });
    const fakes = buildFakes([row], AVAILABLE_REST_PRIMARY);
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.restClient.dispatch.mock.calls[0][0]).toMatchObject({
      customerId: 'CUST-SECRET-11',
    });
    const allLoggedText = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => JSON.stringify(call))
      .join('\n');
    expect(allLoggedText).not.toContain('CUST-SECRET-11');
  });

  it('TC-10 (T-RR-034): reward_tracking_dispatch_tier_total{tier:"kafka"} increments once on success, never on failure', async () => {
    const successRow = fakePendingRow({ id: 'row-success', rewardEntryId: 'entry-success' });
    const successFakes = buildFakes([successRow]);
    successFakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const successMetrics = new DispatchMetricsService();
    await buildService(successFakes, successMetrics).runOnce();
    expect(successMetrics.getDispatchTierCount('kafka')).toBe(1);

    const failureRow = fakePendingRow({ id: 'row-failure', rewardEntryId: 'entry-failure' });
    const failureFakes = buildFakes([failureRow]);
    failureFakes.kafkaProducer.publish.mockRejectedValue(new Error('per-message failure'));
    const failureMetrics = new DispatchMetricsService();
    await buildService(failureFakes, failureMetrics).runOnce();
    expect(failureMetrics.getDispatchTierCount('kafka')).toBe(0);
  });

  it('TC-2 (T-RR-034): Kafka per-message publish failure below threshold -> attempts incremented, row stays PENDING, no fallback attempted yet', async () => {
    const row = fakePendingRow({ attempts: 0 });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockRejectedValue(
      new Error('per-message failure, not broker-unreachable'),
    );
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.outboxRepository.incrementAttempts).toHaveBeenCalledWith('outbox-row-1');
    expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalled();
    expect(fakes.restClient.dispatch).not.toHaveBeenCalled();
  });

  it('TC-6 (T-RR-034): customerId never appears in any log line, on either the success or the failure path', async () => {
    const row = fakePendingRow({ __customerId: 'CUST-SECRET-6' });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('per-message failure'));
    const service = buildService(fakes);

    await service.runOnce();

    const allLoggedText = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => JSON.stringify(call))
      .join('\n');
    expect(allLoggedText).not.toContain('CUST-SECRET-6');
  });

  it('dispatch_channel_config resolves REST as primary/kafkaEnabled: false -> REST attempted directly (this task supersedes T-RR-034s own "skip entirely" placeholder)', async () => {
    const row = fakePendingRow();
    const fakes = buildFakes([row], {
      primaryChannel: 'REST',
      fallbackChannel: 'KAFKA',
      kafkaEnabled: false,
      restEnabled: true,
      grpcEnabled: false,
    });
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.restClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
  });

  it('a row at or above the Kafka-attempts-before-fallback threshold falls through to REST within the same cycle', async () => {
    const row = fakePendingRow({ attempts: THRESHOLD });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('still failing'));
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
    expect(fakes.restClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
  });

  it('an empty batch is a pure no-op — no Kafka/REST call, no repository write, no resolver call', async () => {
    const fakes = buildFakes([]);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.restClient.dispatch).not.toHaveBeenCalled();
    expect(fakes.dispatchResolver.resolve).not.toHaveBeenCalled();
    expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  // T-RR-062: GRPC-as-a-third-channel test cases (TC-4/TC-5/TC-6) live in their own file,
  // `outbox-publisher.grpc-channel.spec.ts` — this task's own "Files owned" list names it
  // separately from this pre-existing spec file.

  it('processes multiple pending rows independently', async () => {
    const rowA = fakePendingRow({ id: 'row-a', rewardEntryId: 'entry-a', __customerId: 'CUST-A' });
    const rowB = fakePendingRow({ id: 'row-b', rewardEntryId: 'entry-b', __customerId: 'CUST-B' });
    const fakes = buildFakes([rowA, rowB]);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(2);
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('row-a');
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('row-b');
  });

  it('TC-8/TC-9 (T-RR-034): runOnce() overlap collapses into one in-flight cycle (never double-fetches/double-publishes)', async () => {
    const row = fakePendingRow();
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const service = buildService(fakes);

    // Two synchronous, back-to-back calls: `cycleInFlight` is set synchronously by the first call,
    // so the second observes it already set and returns the same in-flight promise rather than
    // starting a second, overlapping fetch.
    const first = service.runOnce();
    const second = service.runOnce();
    await Promise.all([first, second]);

    expect(fakes.outboxRepository.findPendingBatch).toHaveBeenCalledTimes(1);
    expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
  });

  it('start()/stop() manage a real interval without throwing, idempotently', async () => {
    const fakes = buildFakes([]);
    const service = buildService(fakes);

    await service.start();
    await service.start();
    service.stop();
    service.stop();
  });

  describe('T-RR-071: one row throwing before any dispatch attempt never aborts the rest of the batch', () => {
    it('TC-1/TC-3: a malformed customerIdEncrypted on the FIRST row (e.g. a stray placeholder string, not real AES-GCM ciphertext) no longer aborts runOnce() — every row after it in the batch still gets its own attempt this cycle', async () => {
      const poisoned = fakePendingRow({
        id: 'row-poisoned',
        rewardEntryId: 'entry-poisoned',
      });
      // Not real ciphertext at all — `EncryptionService.decrypt` throws synchronously on this,
      // exactly the reported "Malformed ciphertext: too short to contain an IV and an auth tag".
      poisoned.payload.customerIdEncrypted = 'ciphertext-placeholder';
      const healthy = fakePendingRow({
        id: 'row-healthy',
        rewardEntryId: 'entry-healthy',
        __customerId: 'CUST-HEALTHY',
      });
      const fakes = buildFakes([poisoned, healthy]);
      fakes.kafkaProducer.publish.mockResolvedValue(undefined);
      const service = buildService(fakes);

      // TC-3's own "prove it fails on the unfixed code" requirement is satisfied by this file's own
      // git history (this task's completion report records the exact reproduction against the
      // pre-fix `doRunOnce`'s bare `for` loop) — asserting the fixed, post-fix behaviour here.
      await expect(service.runOnce()).resolves.toBeUndefined();

      // The row after the poisoned one in `findPendingBatch`'s own result still got its own
      // attempt and was delivered — this is the actual regression this task fixes.
      expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
      expect(fakes.kafkaProducer.publish.mock.calls[0][1]).toBe('CUST-HEALTHY');
      expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('row-healthy');

      // The poisoned row itself never reaches the normal tier-selection flow at all — this catch
      // makes no guess about whether the failure is permanent (implementation note in
      // `outbox-publisher.service.ts`'s own `processRowSafely` header); it only ever calls
      // `recordPreDispatchFailure` (T-INT-051), never `incrementAttempts`/`markFailed`, which
      // remain reserved for the normal per-channel-attempt path.
      expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalledWith('row-poisoned');
      expect(fakes.outboxRepository.markFailed).not.toHaveBeenCalledWith('row-poisoned');
      expect(fakes.outboxRepository.incrementAttempts).not.toHaveBeenCalledWith('row-poisoned');
      // T-INT-051: this cycle's own single failure is recorded (below the poison threshold, so
      // this row alone stays eligible for a later poll — see the dedicated T-INT-051 suite below
      // for the multi-cycle, threshold-crossing case).
      expect(fakes.outboxRepository.recordPreDispatchFailure).toHaveBeenCalledWith(
        'row-poisoned',
        expect.stringContaining('Malformed ciphertext'),
        PRE_DISPATCH_POISON_THRESHOLD,
      );
      expect(fakes.retryRepository.create).not.toHaveBeenCalled();

      // Logged clearly (row id + reward entry id), never silently swallowed.
      const allErrorText = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
      expect(allErrorText).toContain('row-poisoned');
      expect(allErrorText).toContain('entry-poisoned');
      expect(allErrorText).toContain('Malformed ciphertext');
    });

    it('TC-4: an unexpected error from a collaborator other than decrypt (e.g. dispatchResolver.resolve rejecting) is caught exactly the same way — adjacent per-row error handling is unchanged', async () => {
      const badRow = fakePendingRow({ id: 'row-bad-resolve', rewardEntryId: 'entry-bad-resolve' });
      const healthy = fakePendingRow({
        id: 'row-healthy-2',
        rewardEntryId: 'entry-healthy-2',
        __customerId: 'CUST-HEALTHY-2',
      });
      const fakes = buildFakes([badRow, healthy]);
      fakes.dispatchResolver.resolve
        .mockRejectedValueOnce(new Error('dispatch_channel_config lookup failed'))
        .mockResolvedValueOnce(AVAILABLE_KAFKA_PRIMARY);
      fakes.kafkaProducer.publish.mockResolvedValue(undefined);
      const service = buildService(fakes);

      await expect(service.runOnce()).resolves.toBeUndefined();

      expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('row-healthy-2');
      expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalledWith('row-bad-resolve');
    });

    it('TC-4: adjacent behaviour is unchanged — a normal per-message dispatch failure (not a synchronous throw) still increments attempts/escalates exactly as before, for a batch with no poisoned row at all', async () => {
      const row = fakePendingRow({ attempts: 0 });
      const fakes = buildFakes([row]);
      fakes.kafkaProducer.publish.mockRejectedValue(new Error('per-message failure'));
      const service = buildService(fakes);

      await service.runOnce();

      expect(fakes.outboxRepository.incrementAttempts).toHaveBeenCalledWith('outbox-row-1');
      expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalled();
    });
  });

  describe('T-INT-051: a permanently-poisoned row is bounded and no longer starves the FIFO batch forever', () => {
    it('TC-1: a row that throws on every cycle is poisoned once it reaches the configured threshold, and a genuinely dispatchable row queued behind it is no longer starved', async () => {
      const poisoned = fakePendingRow({ id: 'row-poisoned', rewardEntryId: 'entry-poisoned' });
      poisoned.payload.customerIdEncrypted = 'ciphertext-placeholder';
      const fakes = buildFakes([poisoned]);
      // TC-3: `DispatchMetricsService` is real, not faked — same "real collaborator for
      // observable-state assertions" discipline this spec file's own header already documents —
      // so the poisoning outcome below is checked against real counter state, not a mock call.
      const metrics = new DispatchMetricsService();
      const service = buildService(fakes, metrics);

      // Drive PRE_DISPATCH_POISON_THRESHOLD consecutive poll cycles — the same fakes object (and
      // therefore the same stateful `recordPreDispatchFailure` counter map) is reused across all
      // of them, exactly like the real `attempts` column persisting across real poll cycles.
      for (let cycle = 1; cycle <= PRE_DISPATCH_POISON_THRESHOLD; cycle += 1) {
        await service.runOnce();
      }

      expect(fakes.outboxRepository.recordPreDispatchFailure).toHaveBeenCalledTimes(
        PRE_DISPATCH_POISON_THRESHOLD,
      );
      const lastCall =
        fakes.outboxRepository.recordPreDispatchFailure.mock.results[
          PRE_DISPATCH_POISON_THRESHOLD - 1
        ];
      // The fake mirrors the real repository's own contract: once `attempts` reaches the
      // threshold, `poisoned: true` is reported back to the caller.
      await expect(lastCall.value).resolves.toEqual({
        attempts: PRE_DISPATCH_POISON_THRESHOLD,
        poisoned: true,
      });
      // TC-3: this task's own chosen operator-audit mechanism (alongside
      // `RewardTrackingOutboxRepository.findPoisoned()`) — a real, observable counter value, not a
      // change-detector on an internal call.
      expect(metrics.getPoisonedOutboxRowCount()).toBe(1);

      // Now prove the actual starvation fix: a fresh real row enqueued "behind" the
      // already-poisoned one (this session's own reproduction: the poisoned row must never
      // reappear in `findPendingBatch`, freeing every real row queued behind it). Simulate the
      // next poll cycle's `findPendingBatch` result as the real repository would now return it —
      // the poisoned row excluded (its status is no longer `'PENDING'`), only the healthy row
      // present.
      const healthy = fakePendingRow({
        id: 'row-healthy-after-poison',
        rewardEntryId: 'entry-healthy-after-poison',
        __customerId: 'CUST-AFTER-POISON',
      });
      fakes.outboxRepository.findPendingBatch.mockResolvedValueOnce([healthy]);
      fakes.kafkaProducer.publish.mockResolvedValue(undefined);

      await service.runOnce();

      // The real row dispatches on this very next poll cycle — no longer starved behind the
      // permanently-broken row, which this cycle's `findPendingBatch` no longer even returns.
      expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
      expect(fakes.kafkaProducer.publish.mock.calls[0][1]).toBe('CUST-AFTER-POISON');
      expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('row-healthy-after-poison');
      // The poisoned row was not attempted again once it stopped being returned by
      // findPendingBatch — its own recordPreDispatchFailure call count is unchanged from before
      // this last cycle.
      expect(fakes.outboxRepository.recordPreDispatchFailure).toHaveBeenCalledTimes(
        PRE_DISPATCH_POISON_THRESHOLD,
      );
    });

    it('TC-2: a row that fails once (transient) then succeeds on a later attempt, before the threshold, is dispatched normally — the pre-dispatch failure counter never poisons it', async () => {
      const row = fakePendingRow({ id: 'row-transient', rewardEntryId: 'entry-transient' });
      row.payload.customerIdEncrypted = 'ciphertext-placeholder';
      const fakes = buildFakes([row]);
      const service = buildService(fakes);

      // First cycle: decrypt throws (simulated by the malformed ciphertext above) — one
      // pre-dispatch failure recorded, still below PRE_DISPATCH_POISON_THRESHOLD, row stays
      // PENDING.
      await service.runOnce();
      expect(fakes.outboxRepository.recordPreDispatchFailure).toHaveBeenCalledTimes(1);

      // Second cycle: the row is "fixed" (findPendingBatch now returns it with real ciphertext) —
      // the transient failure never recurs, the row dispatches successfully, and no further
      // pre-dispatch failure is ever recorded for it.
      const fixedRow = fakePendingRow({
        id: 'row-transient',
        rewardEntryId: 'entry-transient',
        __customerId: 'CUST-FIXED',
      });
      fakes.outboxRepository.findPendingBatch.mockResolvedValueOnce([fixedRow]);
      fakes.kafkaProducer.publish.mockResolvedValue(undefined);

      await service.runOnce();

      expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
      expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('row-transient');
      // Still only the one pre-dispatch failure ever recorded — never poisoned.
      expect(fakes.outboxRepository.recordPreDispatchFailure).toHaveBeenCalledTimes(1);
    });

    it('TC-3: the maxPreDispatchFailures threshold is resolved via service_config, once per poll cycle, and passed through to every row in that cycle', async () => {
      const rowA = fakePendingRow({ id: 'row-a-poison', rewardEntryId: 'entry-a-poison' });
      rowA.payload.customerIdEncrypted = 'ciphertext-placeholder';
      const rowB = fakePendingRow({ id: 'row-b-poison', rewardEntryId: 'entry-b-poison' });
      rowB.payload.customerIdEncrypted = 'ciphertext-placeholder';
      const fakes = buildFakes([rowA, rowB]);
      const service = buildService(fakes);

      await service.runOnce();

      expect(fakes.configResolver.resolve).toHaveBeenCalledWith(
        'dispatch.outbox.maxPreDispatchFailures',
        'int',
      );
      expect(fakes.outboxRepository.recordPreDispatchFailure).toHaveBeenCalledWith(
        'row-a-poison',
        expect.any(String),
        PRE_DISPATCH_POISON_THRESHOLD,
      );
      expect(fakes.outboxRepository.recordPreDispatchFailure).toHaveBeenCalledWith(
        'row-b-poison',
        expect.any(String),
        PRE_DISPATCH_POISON_THRESHOLD,
      );
    });
  });
});
