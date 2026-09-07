/**
 * T-RR-035 — `RewardTrackingDispatchRetryWorker` against fakes for every collaborator —
 * deterministic, no real broker/HTTP/DB needed (`findDueBatch`'s own `WHERE status = 'pending' AND
 * next_attempt_at <= now()` filtering, TC-6, is covered against the real database by
 * `reward-tracking-dispatch-retry.repository.spec.ts` instead — this suite only proves what the
 * worker itself does once handed a batch of due rows).
 *
 * `EncryptionService` is the one **real** collaborator (not faked), so the decrypted `customerId`
 * assertions prove R8's boundary end to end, not just that some decrypt method was called.
 * `DispatchMetricsService` is likewise real, so the `{tier:'retry_table'}` assertion checks a real
 * counter value.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { DispatchMetricsService } from '@/modules/dispatch/dispatch-metrics.service';
import { RewardTrackingDispatchRetryWorker } from '@/modules/dispatch/reward-tracking-dispatch-retry.worker';
import type {
  DispatchChannelResolverService,
  ResolvedDispatchChannel,
} from '@/modules/dispatch/dispatch-channel-resolver.service';
import type {
  DueRetryRow,
  RewardTrackingDispatchRetryRepository,
} from '@/modules/dispatch/reward-tracking-dispatch-retry.repository';
import type { RewardTrackingKafkaProducerClient } from '@/modules/dispatch/reward-tracking-kafka-producer.client';
import type { RewardTrackingRestClient } from '@/modules/dispatch/reward-tracking-rest.client';
import type { DispatchServiceConfigResolver } from '@/modules/dispatch/dispatch.config';

const AES_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const MAX_ATTEMPTS = 3;
const AVAILABLE_KAFKA_PRIMARY: ResolvedDispatchChannel = {
  primaryChannel: 'KAFKA',
  fallbackChannel: 'REST',
  kafkaEnabled: true,
  restEnabled: true,
};

function fakeDueRow(overrides: Partial<DueRetryRow> & { __customerId?: string } = {}): DueRetryRow {
  const customerId = overrides.__customerId ?? 'CUST-RETRY';
  return {
    id: 'retry-row-1',
    rewardEntryId: 'reward-entry-1',
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    status: 'pending',
    lastError: null,
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
    },
    ...overrides,
  };
}

interface Fakes {
  retryRepository: RewardTrackingDispatchRetryRepository & {
    findDueBatch: jest.Mock;
    recordAttemptFailure: jest.Mock;
    markExhausted: jest.Mock;
    markDelivered: jest.Mock;
  };
  dispatchResolver: DispatchChannelResolverService & { resolve: jest.Mock };
  kafkaProducer: RewardTrackingKafkaProducerClient & { publish: jest.Mock };
  restClient: RewardTrackingRestClient & { dispatch: jest.Mock };
  configResolver: DispatchServiceConfigResolver;
}

function buildFakes(
  dueRows: DueRetryRow[],
  resolved: ResolvedDispatchChannel = AVAILABLE_KAFKA_PRIMARY,
): Fakes {
  return {
    retryRepository: {
      findDueBatch: jest.fn().mockResolvedValue(dueRows),
      recordAttemptFailure: jest.fn().mockResolvedValue(undefined),
      markExhausted: jest.fn().mockResolvedValue(undefined),
      markDelivered: jest.fn().mockResolvedValue(undefined),
    } as unknown as Fakes['retryRepository'],
    dispatchResolver: {
      resolve: jest.fn().mockResolvedValue(resolved),
    } as unknown as Fakes['dispatchResolver'],
    kafkaProducer: { publish: jest.fn() } as unknown as Fakes['kafkaProducer'],
    restClient: { dispatch: jest.fn() } as unknown as Fakes['restClient'],
    configResolver: {
      resolve: jest.fn(async (key: string) => {
        if (key === 'dispatch.retry.maxAttempts') {
          return MAX_ATTEMPTS;
        }
        throw new Error(`unexpected service_config key "${key}" resolved in this test`);
      }) as unknown as DispatchServiceConfigResolver['resolve'],
    },
  };
}

function buildWorker(
  fakes: Fakes,
  metrics: DispatchMetricsService = new DispatchMetricsService(),
): RewardTrackingDispatchRetryWorker {
  return new RewardTrackingDispatchRetryWorker(
    fakes.retryRepository,
    fakes.dispatchResolver,
    encryption,
    fakes.kafkaProducer,
    fakes.restClient,
    metrics,
    fakes.configResolver,
    5_000,
    20,
    1_000,
    60_000,
    false,
  );
}

describe('T-RR-035 — RewardTrackingDispatchRetryWorker', () => {
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

  it('TC-7: a due row resolves via Kafka -> markDelivered called, tier metric increments, real decrypted customerId used', async () => {
    const row = fakeDueRow({ __customerId: 'CUST-7' });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const metrics = new DispatchMetricsService();
    const worker = buildWorker(fakes, metrics);

    await worker.runOnce();

    expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
    const [, key, message] = fakes.kafkaProducer.publish.mock.calls[0];
    expect(key).toBe('CUST-7');
    expect(message.customerId).toBe('CUST-7');
    expect(fakes.retryRepository.markDelivered).toHaveBeenCalledWith('retry-row-1');
    expect(metrics.getDispatchTierCount('retry_table')).toBe(1);
  });

  it('TC-7: falls through to REST when Kafka fails, still resolves', async () => {
    const row = fakeDueRow();
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('still down'));
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const worker = buildWorker(fakes);

    await worker.runOnce();

    expect(fakes.kafkaProducer.publish).toHaveBeenCalledTimes(1);
    expect(fakes.restClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.retryRepository.markDelivered).toHaveBeenCalledWith('retry-row-1');
  });

  it('TC-8: both channels fail, below max attempts -> recordAttemptFailure with an advanced next_attempt_at', async () => {
    const row = fakeDueRow({ attempts: 0 });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('kafka down'));
    fakes.restClient.dispatch.mockRejectedValue(new Error('rest down'));
    const worker = buildWorker(fakes);

    const before = Date.now();
    await worker.runOnce();

    expect(fakes.retryRepository.markExhausted).not.toHaveBeenCalled();
    expect(fakes.retryRepository.recordAttemptFailure).toHaveBeenCalledTimes(1);
    const [id, reason, nextAttemptAt] = fakes.retryRepository.recordAttemptFailure.mock.calls[0];
    expect(id).toBe('retry-row-1');
    expect(reason).toEqual(expect.any(String));
    expect((nextAttemptAt as Date).getTime()).toBeGreaterThan(before);
  });

  it('TC-8: both channels fail at the max-attempts ceiling -> markExhausted, no further scheduling', async () => {
    const row = fakeDueRow({ attempts: MAX_ATTEMPTS - 1 });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('kafka down'));
    fakes.restClient.dispatch.mockRejectedValue(new Error('rest down'));
    const worker = buildWorker(fakes);

    await worker.runOnce();

    expect(fakes.retryRepository.markExhausted).toHaveBeenCalledWith(
      'retry-row-1',
      expect.any(String),
    );
    expect(fakes.retryRepository.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("TC-9: dispatch_channel_config is re-resolved every due cycle from the row's own scope fields", async () => {
    const row = fakeDueRow({
      rewardCode: 'RWD-X',
      trackerCode: 'TRK-X',
      campaignCode: 'CAMP-X',
      tenantId: 42,
    });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const worker = buildWorker(fakes);

    await worker.runOnce();

    expect(fakes.dispatchResolver.resolve).toHaveBeenCalledWith({
      rewardCode: 'RWD-X',
      trackerCode: 'TRK-X',
      campaignCode: 'CAMP-X',
      tenantId: 42,
    });
  });

  it("TC-9: a config change since the row's first failure changes which channel is attempted this cycle", async () => {
    const row = fakeDueRow();
    // Resolved to REST-only this cycle (Kafka disabled) — different from whatever the row's own
    // original outbox resolution might have been.
    const fakes = buildFakes([row], {
      primaryChannel: 'REST',
      fallbackChannel: 'KAFKA',
      kafkaEnabled: false,
      restEnabled: true,
    });
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const worker = buildWorker(fakes);

    await worker.runOnce();

    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.restClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.retryRepository.markDelivered).toHaveBeenCalledWith('retry-row-1');
  });

  it('customerId is never logged, on success or failure', async () => {
    const row = fakeDueRow({ __customerId: 'CUST-SECRET-RETRY' });
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockRejectedValue(new Error('kafka down'));
    fakes.restClient.dispatch.mockRejectedValue(new Error('rest down'));
    const worker = buildWorker(fakes);

    await worker.runOnce();

    const loggedText = [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((call) => JSON.stringify(call))
      .join('\n');
    expect(loggedText).not.toContain('CUST-SECRET-RETRY');
  });

  it('an empty due batch is a pure no-op', async () => {
    const fakes = buildFakes([]);
    const worker = buildWorker(fakes);

    await worker.runOnce();

    expect(fakes.dispatchResolver.resolve).not.toHaveBeenCalled();
    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.restClient.dispatch).not.toHaveBeenCalled();
  });

  it('runOnce() overlap collapses into one in-flight cycle', async () => {
    const row = fakeDueRow();
    const fakes = buildFakes([row]);
    fakes.kafkaProducer.publish.mockResolvedValue(undefined);
    const worker = buildWorker(fakes);

    const first = worker.runOnce();
    const second = worker.runOnce();
    await Promise.all([first, second]);

    expect(fakes.retryRepository.findDueBatch).toHaveBeenCalledTimes(1);
  });

  it('start()/stop() manage a real interval without throwing, idempotently', async () => {
    const fakes = buildFakes([]);
    const worker = buildWorker(fakes);

    worker.start();
    worker.start();
    worker.stop();
    worker.stop();
  });
});
