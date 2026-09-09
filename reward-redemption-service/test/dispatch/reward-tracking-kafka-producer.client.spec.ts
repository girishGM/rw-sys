/**
 * T-RR-035 — `RewardTrackingKafkaProducerClient`'s own `KafkaBrokerUnreachableError` distinction
 * (T-RR-034 built the rest of this class; this task extends it, that file's own header) —
 * exercised against a mocked `kafkajs` `Kafka`/`Producer` so this suite never opens a real socket.
 * `OutboxPublisherService`'s own test suite already proves the *consuming* side of this
 * distinction (an immediate REST fallback on broker-unreachable); this suite proves the
 * *producing* side — that this class actually throws the right error type for the right failure.
 */
import 'reflect-metadata';
import { KafkaJSConnectionError } from 'kafkajs';
import type { ConfigService } from '@nestjs/config';
import type { Config } from '@/config/config.schema';
import {
  KafkaBrokerUnreachableError,
  RewardTrackingKafkaProducerClient,
} from '@/modules/dispatch/reward-tracking-kafka-producer.client';

const mockConnect = jest.fn();
const mockSend = jest.fn();
const mockDisconnect = jest.fn();

jest.mock('kafkajs', () => {
  const actual = jest.requireActual('kafkajs');
  return {
    ...actual,
    Kafka: jest.fn().mockImplementation(() => ({
      producer: () => ({
        connect: mockConnect,
        send: mockSend,
        disconnect: mockDisconnect,
      }),
    })),
  };
});

function fakeConfigService(): ConfigService<Config, true> {
  return {
    get: () => 'localhost:9094',
  } as unknown as ConfigService<Config, true>;
}

describe('T-RR-035 — RewardTrackingKafkaProducerClient (KafkaBrokerUnreachableError)', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockSend.mockReset();
    mockDisconnect.mockReset().mockResolvedValue(undefined);
  });

  it('wraps a connect() failure as KafkaBrokerUnreachableError', async () => {
    mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new RewardTrackingKafkaProducerClient(fakeConfigService());

    await expect(client.publish('topic', 'key', { a: 1 })).rejects.toThrow(
      KafkaBrokerUnreachableError,
    );
  });

  it('wraps a KafkaJSConnectionError raised from send() as KafkaBrokerUnreachableError', async () => {
    mockConnect.mockResolvedValue(undefined);
    mockSend.mockRejectedValue(new KafkaJSConnectionError('connection dropped'));
    const client = new RewardTrackingKafkaProducerClient(fakeConfigService());

    await expect(client.publish('topic', 'key', { a: 1 })).rejects.toThrow(
      KafkaBrokerUnreachableError,
    );
  });

  it('does NOT wrap an ordinary per-message send() failure — rethrown as-is', async () => {
    mockConnect.mockResolvedValue(undefined);
    mockSend.mockRejectedValue(new Error('this specific message was rejected'));
    const client = new RewardTrackingKafkaProducerClient(fakeConfigService());

    await expect(client.publish('topic', 'key', { a: 1 })).rejects.toThrow(
      'this specific message was rejected',
    );
    await expect(client.publish('topic', 'key', { a: 1 })).rejects.not.toThrow(
      KafkaBrokerUnreachableError,
    );
  });

  it('a successful connect + send never throws', async () => {
    mockConnect.mockResolvedValue(undefined);
    mockSend.mockResolvedValue(undefined);
    const client = new RewardTrackingKafkaProducerClient(fakeConfigService());

    await expect(client.publish('topic', 'key', { a: 1 })).resolves.toBeUndefined();
  });
});
