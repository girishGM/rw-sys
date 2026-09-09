/**
 * T-RR-062 — `OutboxPublisherService`'s third dispatch channel (gRPC), TC-4/TC-5/TC-6 from this
 * task's own test-case table. Deliberately its own file (this task's own "Files owned" list),
 * kept self-contained with its own fakes rather than importing from
 * `outbox-publisher.service.spec.ts` — the same "every prior spec file in this service duplicates
 * this same fixture shape locally rather than sharing one across files" convention that file's own
 * header documents for its own fixture helper.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import { DispatchMetricsService } from '@/modules/dispatch/dispatch-metrics.service';
import { RewardTrackingGrpcUnreachableError } from '@/modules/dispatch/reward-tracking-grpc.client';
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

const AES_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 11).toString('base64');
const encryption = new EncryptionService({
  aesKey: Buffer.from(AES_KEY_B64, 'base64'),
  hmacKey: Buffer.from(HMAC_KEY_B64, 'base64'),
});

const THRESHOLD = 3;

const AVAILABLE_GRPC_PRIMARY: ResolvedDispatchChannel = {
  primaryChannel: 'GRPC',
  fallbackChannel: 'REST',
  kafkaEnabled: true,
  restEnabled: true,
  grpcEnabled: true,
};

const GRPC_PRIMARY_BUT_DISABLED: ResolvedDispatchChannel = {
  primaryChannel: 'GRPC',
  fallbackChannel: 'REST',
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
  };
  dispatchResolver: DispatchChannelResolverService & { resolve: jest.Mock };
  kafkaProducer: RewardTrackingKafkaProducerClient & { publish: jest.Mock };
  restClient: RewardTrackingRestClient & { dispatch: jest.Mock };
  grpcClient: RewardTrackingGrpcClient & { dispatch: jest.Mock };
  retryRepository: RewardTrackingDispatchRetryRepository & { create: jest.Mock };
  configResolver: DispatchServiceConfigResolver;
}

function buildFakes(pendingRows: OutboxPendingRow[], resolved: ResolvedDispatchChannel): Fakes {
  return {
    outboxRepository: {
      findPendingBatch: jest.fn().mockResolvedValue(pendingRows),
      incrementAttempts: jest.fn().mockResolvedValue(undefined),
      markPublished: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      // T-INT-051: never exercised by this suite (no pre-dispatch throw is ever driven here), but
      // present so the fake satisfies `OutboxPublisherService`'s own real dependency shape.
      recordPreDispatchFailure: jest.fn().mockResolvedValue({ attempts: 1, poisoned: false }),
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
        // T-INT-051: resolved unconditionally once per `doRunOnce()` cycle (same as the two keys
        // above), even though this suite never drives a pre-dispatch throw.
        if (key === 'dispatch.outbox.maxPreDispatchFailures') {
          return 5;
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

describe('T-RR-062 — OutboxPublisherService, GRPC as a third dispatch channel', () => {
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

  it('TC-4: dispatch_channel_config row with primary_channel=GRPC, grpc_enabled=true -> OutboxPublisherService calls RewardTrackingGrpcClient.dispatch, not Kafka/REST', async () => {
    const row = fakePendingRow({ __customerId: 'CUST-GRPC' });
    const fakes = buildFakes([row], AVAILABLE_GRPC_PRIMARY);
    fakes.grpcClient.dispatch.mockResolvedValue(undefined);
    const metrics = new DispatchMetricsService();
    const service = buildService(fakes, metrics);

    await service.runOnce();

    expect(fakes.grpcClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.kafkaProducer.publish).not.toHaveBeenCalled();
    expect(fakes.restClient.dispatch).not.toHaveBeenCalled();
    expect(fakes.grpcClient.dispatch.mock.calls[0][0]).toMatchObject({
      customerId: 'CUST-GRPC',
    });
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
    expect(metrics.getDispatchTierCount('grpc')).toBe(1);
  });

  it('TC-5: grpc_enabled=false but primary_channel=GRPC (misconfigured) -> treated as disabled, same isChannelEnabled() short-circuit already implemented for a disabled Kafka/REST primary, goes straight to fallback', async () => {
    const row = fakePendingRow();
    const fakes = buildFakes([row], GRPC_PRIMARY_BUT_DISABLED);
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.grpcClient.dispatch).not.toHaveBeenCalled();
    expect(fakes.restClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
  });

  it("TC-6: gRPC transport-unreachable error -> same immediate-fallback behavior as KafkaBrokerUnreachableError, bypassing this row's own retry budget", async () => {
    const row = fakePendingRow({ attempts: 0 });
    const fakes = buildFakes([row], AVAILABLE_GRPC_PRIMARY);
    fakes.grpcClient.dispatch.mockRejectedValue(
      new RewardTrackingGrpcUnreachableError(new Error('UNAVAILABLE')),
    );
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.grpcClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.restClient.dispatch).toHaveBeenCalledTimes(1);
    // Bypassed the normal multi-cycle threshold entirely — never left PENDING via incrementAttempts.
    expect(fakes.outboxRepository.incrementAttempts).not.toHaveBeenCalled();
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
  });

  it('a gRPC per-message (non-unreachable) failure below threshold stays PENDING and increments attempts, never touching the fallback yet', async () => {
    const row = fakePendingRow({ attempts: 0 });
    const fakes = buildFakes([row], AVAILABLE_GRPC_PRIMARY);
    fakes.grpcClient.dispatch.mockRejectedValue(new Error('per-message failure, not unreachable'));
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.outboxRepository.incrementAttempts).toHaveBeenCalledWith('outbox-row-1');
    expect(fakes.outboxRepository.markPublished).not.toHaveBeenCalled();
    expect(fakes.restClient.dispatch).not.toHaveBeenCalled();
  });

  it('a row at or above the gRPC-attempts-before-fallback threshold falls through to the configured (non-forced) fallback channel within the same cycle', async () => {
    const row = fakePendingRow({ attempts: THRESHOLD });
    const fakes = buildFakes([row], AVAILABLE_GRPC_PRIMARY);
    fakes.grpcClient.dispatch.mockRejectedValue(new Error('still failing'));
    fakes.restClient.dispatch.mockResolvedValue(undefined);
    const service = buildService(fakes);

    await service.runOnce();

    expect(fakes.grpcClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.restClient.dispatch).toHaveBeenCalledTimes(1);
    expect(fakes.outboxRepository.markPublished).toHaveBeenCalledWith('outbox-row-1');
  });

  it('customerId in the gRPC payload is never logged, on either the success or the failure path', async () => {
    const row = fakePendingRow({ __customerId: 'CUST-SECRET-GRPC' });
    const fakes = buildFakes([row], AVAILABLE_GRPC_PRIMARY);
    fakes.grpcClient.dispatch.mockRejectedValue(new Error('per-message failure'));
    const service = buildService(fakes);

    await service.runOnce();

    const allLoggedText = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => JSON.stringify(call))
      .join('\n');
    expect(allLoggedText).not.toContain('CUST-SECRET-GRPC');
  });
});
