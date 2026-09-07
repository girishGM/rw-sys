/**
 * T-RR-081 — `PromoCodeServiceKafkaClient`, exercised against a mocked `kafkajs` `Kafka`/
 * `Producer`/`Consumer` — same "a shared, fixed consumer group is a real-broker testing hazard,
 * not a property to prove against a live socket" discipline `reward-tracking-kafka-producer.client
 * .spec.ts` (T-RR-035) and `reward-entry-created.consumer.spec.ts` (T-RR-012) already establish
 * for this exact class of producer/consumer wiring in this repo: this suite proves the real
 * register→publish→resolve/timeout/drop logic and the real `start()` wiring (groupId, topic,
 * `eachMessage` → `handleResultMessage`) without ever opening a real broker connection, so it can
 * never be flaky or collide with another spec file's own consumer group on the shared local
 * broker. `handleResultMessage`'s own malformed-message robustness (TC-3-adjacent) needs no
 * `kafkajs` mock at all — proven as a pure function in the first `describe` block.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Config } from '@/config/config.schema';

const mockProducerConnect = jest.fn();
const mockProducerSend = jest.fn();
const mockProducerDisconnect = jest.fn();
const mockConsumerConnect = jest.fn();
const mockConsumerSubscribe = jest.fn();
const mockConsumerRun = jest.fn();
const mockConsumerDisconnect = jest.fn();
const kafkaProducerFactory = jest.fn(() => ({
  connect: mockProducerConnect,
  send: mockProducerSend,
  disconnect: mockProducerDisconnect,
}));
const kafkaConsumerFactory = jest.fn(() => ({
  connect: mockConsumerConnect,
  subscribe: mockConsumerSubscribe,
  run: mockConsumerRun,
  disconnect: mockConsumerDisconnect,
}));

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: kafkaProducerFactory,
    consumer: kafkaConsumerFactory,
  })),
  logLevel: { NOTHING: 0 },
}));

import {
  DEFAULT_KAFKA_REPLY_TIMEOUT_MS,
  PROMO_CODE_GENERATE_RESULT_CONSUMER_GROUP,
  PROMO_CODE_GENERATE_RESULT_TOPIC,
  PromoCodeServiceKafkaClient,
  type PromoCodeGenerateRequestData,
  type PromoCodeKafkaServiceConfigResolver,
} from '@/modules/connectors/promo-code-service-kafka.client';
import { PromoCodeKafkaReplyTimeoutError } from '@/modules/connectors/promo-code-kafka-request-reply.registry';

function fakeConfigService(): ConfigService<Config, true> {
  return { get: () => 'localhost:9094' } as unknown as ConfigService<Config, true>;
}

function fixedTimeoutResolver(timeoutMs: number): PromoCodeKafkaServiceConfigResolver {
  return { resolve: jest.fn().mockResolvedValue(timeoutMs) };
}

function unseededResolver(): PromoCodeKafkaServiceConfigResolver {
  return { resolve: jest.fn().mockRejectedValue(new Error('unseeded')) };
}

function requestData(
  overrides: Partial<PromoCodeGenerateRequestData> = {},
): PromoCodeGenerateRequestData {
  return {
    bindLevel: 'CAMPAIGN',
    bindRefId: 'CAMP_T_RR_081',
    customerId: 'MSISDN-60123456789',
    merchantId: 'MERCH_T_RR_081',
    // T-RR-090.
    versionNo: null,
    activityContext: { amount: '50.0000', currency: 'MYR', metadata: {} },
    ...overrides,
  };
}

/** Waits a handful of real microtask/timer ticks — enough for every `await` hop inside
 * `requestAndAwaitReply` (resolving the timeout, then publishing through the mocked producer,
 * both mocked to resolve instantly) to actually settle, so the pending entry is guaranteed to
 * exist in the registry before a test drives `handleResultMessage` itself. */
function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registryOf(client: PromoCodeServiceKafkaClient): { pendingCount: number } {
  return (client as unknown as { registry: { pendingCount: number } }).registry;
}

describe('T-RR-081 — PromoCodeServiceKafkaClient.handleResultMessage (pure, no kafkajs mock needed)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function client(): PromoCodeServiceKafkaClient {
    return new PromoCodeServiceKafkaClient(fakeConfigService(), unseededResolver());
  }

  it('routes a well-formed SUCCESS envelope to the registry, resolving any pending caller', async () => {
    const c = client();
    const correlationId = randomUUID();
    const pending = (
      c as unknown as {
        registry: { register: (id: string, ms: number) => Promise<unknown> };
      }
    ).registry.register(correlationId, 5_000);

    c.handleResultMessage(
      JSON.stringify({
        eventId: randomUUID(),
        correlationId,
        tenantId: '1',
        source: 'promo-code-service',
        data: {
          status: 'SUCCESS',
          promoCodeId: 'pc-1',
          code: 'WELCOME10',
          rewardValueType: 'PERCENTAGE',
          rewardValue: '10.0000',
          rewardUnit: '%',
          expiresAt: '2026-12-01T00:00:00.000Z',
          errorCode: null,
          errorMessage: null,
        },
      }),
    );

    await expect(pending).resolves.toEqual({
      status: 'SUCCESS',
      promoCodeId: 'pc-1',
      code: 'WELCOME10',
      rewardValueType: 'PERCENTAGE',
      rewardValue: '10.0000',
      rewardUnit: '%',
      expiresAt: '2026-12-01T00:00:00.000Z',
      errorCode: null,
      errorMessage: null,
      // T-RR-090: absent on this envelope -> defaults to null.
      versionNo: null,
    });
  });

  it('unparseable JSON is logged and dropped, never throws', () => {
    expect(() => client().handleResultMessage('{not json')).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('null message value is logged and dropped, never throws', () => {
    expect(() => client().handleResultMessage(null)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('a JSON array (not an object) is logged and dropped, never throws', () => {
    expect(() => client().handleResultMessage('[1,2,3]')).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('a message missing correlationId is logged and dropped, never throws', () => {
    expect(() =>
      client().handleResultMessage(JSON.stringify({ data: { status: 'SUCCESS' } })),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('a message with an unrecognized data.status is logged and dropped, never throws', () => {
    expect(() =>
      client().handleResultMessage(
        JSON.stringify({ correlationId: randomUUID(), data: { status: 'BOGUS' } }),
      ),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('TC-3: a well-formed result for a correlationId with no pending entry is logged and dropped, never throws (late/redelivered)', () => {
    expect(() =>
      client().handleResultMessage(
        JSON.stringify({
          correlationId: randomUUID(),
          data: { status: 'SUCCESS', errorCode: null, errorMessage: null },
        }),
      ),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('resolveTimeoutMs falls back to DEFAULT_KAFKA_REPLY_TIMEOUT_MS with a warn log when service_config is unseeded', async () => {
    const resolved = await (
      client() as unknown as { resolveTimeoutMs: () => Promise<number> }
    ).resolveTimeoutMs();

    expect(resolved).toBe(DEFAULT_KAFKA_REPLY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('T-RR-081 — PromoCodeServiceKafkaClient against a mocked kafkajs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProducerConnect.mockResolvedValue(undefined);
    mockProducerSend.mockResolvedValue(undefined);
    mockProducerDisconnect.mockResolvedValue(undefined);
    mockConsumerConnect.mockResolvedValue(undefined);
    mockConsumerSubscribe.mockResolvedValue(undefined);
    mockConsumerRun.mockResolvedValue(undefined);
    mockConsumerDisconnect.mockResolvedValue(undefined);
  });

  it('TC-1: publish a request, then deliver a matching SUCCESS result -> requestAndAwaitReply resolves with the correct data, and the correct topic/key/envelope were sent', async () => {
    const client = new PromoCodeServiceKafkaClient(
      fakeConfigService(),
      fixedTimeoutResolver(5_000),
    );
    const correlationId = randomUUID();

    const resultPromise = client.requestAndAwaitReply(correlationId, '1', requestData());
    await flush();
    expect(registryOf(client).pendingCount).toBe(1);
    expect(mockProducerSend).toHaveBeenCalledTimes(1);
    const sendArgs = mockProducerSend.mock.calls[0][0] as {
      topic: string;
      messages: Array<{ key: string; value: string }>;
    };
    expect(sendArgs.topic).toBe('promo-code.generate.requested.v1');
    expect(sendArgs.messages[0].key).toBe(correlationId);
    const envelope = JSON.parse(sendArgs.messages[0].value) as {
      correlationId: string;
      tenantId: string;
      eventType: string;
      data: PromoCodeGenerateRequestData;
    };
    expect(envelope.correlationId).toBe(correlationId);
    expect(envelope.tenantId).toBe('1');
    expect(envelope.eventType).toBe('promo-code.generate.requested');
    expect(envelope.data).toEqual(requestData());

    client.handleResultMessage(
      JSON.stringify({
        correlationId,
        tenantId: '1',
        data: {
          status: 'SUCCESS',
          promoCodeId: 'pc-mock-1',
          code: 'WELCOME10-MOCK',
          rewardValueType: 'PERCENTAGE',
          rewardValue: '10.0000',
          rewardUnit: '%',
          expiresAt: '2026-12-01T00:00:00.000Z',
          errorCode: null,
          errorMessage: null,
        },
      }),
    );

    await expect(resultPromise).resolves.toMatchObject({
      status: 'SUCCESS',
      promoCodeId: 'pc-mock-1',
      code: 'WELCOME10-MOCK',
    });
    expect(registryOf(client).pendingCount).toBe(0);
  });

  it('TC-2: no result ever arrives -> requestAndAwaitReply rejects with PromoCodeKafkaReplyTimeoutError at the configured window, and the pending entry is removed', async () => {
    const client = new PromoCodeServiceKafkaClient(fakeConfigService(), fixedTimeoutResolver(50));

    await expect(
      client.requestAndAwaitReply(randomUUID(), '1', requestData()),
    ).rejects.toBeInstanceOf(PromoCodeKafkaReplyTimeoutError);
    expect(registryOf(client).pendingCount).toBe(0);
  });

  it('a publish failure (producer connect rejects) rejects with a plain Error, never PromoCodeKafkaReplyTimeoutError, and leaves no dangling registry entry', async () => {
    mockProducerConnect.mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new PromoCodeServiceKafkaClient(
      fakeConfigService(),
      fixedTimeoutResolver(30_000),
    );

    await expect(
      client.requestAndAwaitReply(randomUUID(), '1', requestData()),
    ).rejects.not.toBeInstanceOf(PromoCodeKafkaReplyTimeoutError);
    expect(registryOf(client).pendingCount).toBe(0);
  });

  it('a publish failure (producer send rejects) rejects with a plain Error and leaves no dangling registry entry', async () => {
    mockProducerSend.mockRejectedValue(new Error('this message was rejected'));
    const client = new PromoCodeServiceKafkaClient(
      fakeConfigService(),
      fixedTimeoutResolver(30_000),
    );

    await expect(client.requestAndAwaitReply(randomUUID(), '1', requestData())).rejects.toThrow(
      'this message was rejected',
    );
    expect(registryOf(client).pendingCount).toBe(0);
  });

  it('start() wires a consumer under the fixed shared group/topic, and its real eachMessage callback drives handleResultMessage -> resolves a pending caller', async () => {
    const client = new PromoCodeServiceKafkaClient(
      fakeConfigService(),
      fixedTimeoutResolver(5_000),
    );

    await client.start();

    expect(kafkaConsumerFactory).toHaveBeenCalledWith({
      groupId: PROMO_CODE_GENERATE_RESULT_CONSUMER_GROUP,
    });
    expect(mockConsumerSubscribe).toHaveBeenCalledWith({
      topic: PROMO_CODE_GENERATE_RESULT_TOPIC,
      fromBeginning: false,
    });
    expect(mockConsumerRun).toHaveBeenCalledTimes(1);

    const correlationId = randomUUID();
    const pending = (
      client as unknown as {
        registry: { register: (id: string, ms: number) => Promise<unknown> };
      }
    ).registry.register(correlationId, 5_000);

    const runArgs = mockConsumerRun.mock.calls[0][0] as {
      eachMessage: (payload: { message: { value: Buffer } }) => Promise<void>;
    };
    await runArgs.eachMessage({
      message: {
        value: Buffer.from(
          JSON.stringify({
            correlationId,
            data: { status: 'FAILED', errorCode: 'CONFIG_INACTIVE', errorMessage: 'inactive' },
          }),
        ),
      },
    });

    await expect(pending).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'CONFIG_INACTIVE',
    });
  });

  it('start() is idempotent — a second call while already running never opens a second consumer', async () => {
    const client = new PromoCodeServiceKafkaClient(
      fakeConfigService(),
      fixedTimeoutResolver(5_000),
    );

    await client.start();
    await client.start();

    expect(kafkaConsumerFactory).toHaveBeenCalledTimes(1);
  });

  it('stop()/onModuleDestroy() disconnect the consumer and producer when they were opened', async () => {
    const client = new PromoCodeServiceKafkaClient(
      fakeConfigService(),
      fixedTimeoutResolver(5_000),
    );
    await client.start();
    const correlationId = randomUUID();
    const resultPromise = client.requestAndAwaitReply(correlationId, '1', requestData());
    await flush();
    // Settles the pending entry immediately, rather than leaving its timer dangling for the rest
    // of this test file's process lifetime.
    client.handleResultMessage(
      JSON.stringify({
        correlationId,
        data: { status: 'SUCCESS', errorCode: null, errorMessage: null },
      }),
    );
    await resultPromise;

    await client.onModuleDestroy();

    expect(mockConsumerDisconnect).toHaveBeenCalledTimes(1);
    expect(mockProducerDisconnect).toHaveBeenCalledTimes(1);
  });
});
