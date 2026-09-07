/**
 * T-RR-012. Unit tests for `RewardEntryCreatedDlqProducer` — `kafkajs` itself is mocked (no real
 * broker), so this suite proves lazy-connect-on-first-publish, single-flight connect, and
 * throw-don't-swallow behaviour deterministically and fast. Real-broker DLQ delivery is proven
 * separately by the manual verification steps in this task's own completion report.
 */
import type { ConfigService } from '@nestjs/config';
import type { Config } from '@/config/config.schema';

const connect = jest.fn();
const send = jest.fn();
const disconnect = jest.fn();
const producerFactory = jest.fn(() => ({ connect, send, disconnect }));

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({ producer: producerFactory })),
  logLevel: { NOTHING: 0 },
}));

import {
  RewardEntryCreatedDlqProducer,
  REWARD_ENTRY_CREATED_DLQ_TOPIC,
} from '@/messaging/ingest/reward-entry-created-dlq.producer';

function buildConfigService(): ConfigService<Config, true> {
  return {
    get: (key: string) => {
      if (key === 'KAFKA_BROKERS') {
        return 'localhost:9094, localhost:9095';
      }
      throw new Error(`unexpected config key requested in test: ${key}`);
    },
  } as unknown as ConfigService<Config, true>;
}

describe('RewardEntryCreatedDlqProducer', () => {
  beforeEach(() => {
    connect.mockReset().mockResolvedValue(undefined);
    send.mockReset().mockResolvedValue(undefined);
    disconnect.mockReset().mockResolvedValue(undefined);
    producerFactory.mockClear();
  });

  it('does not connect at construction time (lazy connect only)', () => {
    new RewardEntryCreatedDlqProducer(buildConfigService());
    expect(connect).not.toHaveBeenCalled();
  });

  it('connects on the first publish and sends the message to reward.entry.created.dlq.v1', async () => {
    const producer = new RewardEntryCreatedDlqProducer(buildConfigService());

    await producer.publish('cust-1', { id: 'entry-1', error: 'boom', failedAt: 'now' });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      topic: REWARD_ENTRY_CREATED_DLQ_TOPIC,
      messages: [
        { key: 'cust-1', value: JSON.stringify({ id: 'entry-1', error: 'boom', failedAt: 'now' }) },
      ],
    });
  });

  it('splits and trims the comma-separated KAFKA_BROKERS list', async () => {
    const { Kafka } = jest.requireMock('kafkajs') as { Kafka: jest.Mock };
    const producer = new RewardEntryCreatedDlqProducer(buildConfigService());

    await producer.publish(null, { error: 'x' });

    expect(Kafka).toHaveBeenCalledWith(
      expect.objectContaining({ brokers: ['localhost:9094', 'localhost:9095'] }),
    );
  });

  it('publishes with no key as undefined (kafkajs default partitioner), never a stringified null', async () => {
    const producer = new RewardEntryCreatedDlqProducer(buildConfigService());

    await producer.publish(null, { error: 'x' });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [expect.objectContaining({ key: undefined })] }),
    );
  });

  it('only connects once across multiple publishes', async () => {
    const producer = new RewardEntryCreatedDlqProducer(buildConfigService());

    await producer.publish('a', { error: '1' });
    await producer.publish('b', { error: '2' });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('concurrent publishes before the first connect resolves still only connect once (single-flight)', async () => {
    let resolveConnect: () => void = () => undefined;
    connect.mockReset().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const producer = new RewardEntryCreatedDlqProducer(buildConfigService());

    const first = producer.publish('a', { error: '1' });
    const second = producer.publish('b', { error: '2' });
    resolveConnect();
    await Promise.all([first, second]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('propagates (never swallows) a send failure', async () => {
    send.mockRejectedValue(new Error('broker unreachable'));
    const producer = new RewardEntryCreatedDlqProducer(buildConfigService());

    await expect(producer.publish('a', { error: '1' })).rejects.toThrow('broker unreachable');
  });

  it('propagates a connect failure', async () => {
    connect.mockRejectedValue(new Error('cannot reach broker'));
    const producer = new RewardEntryCreatedDlqProducer(buildConfigService());

    await expect(producer.publish('a', { error: '1' })).rejects.toThrow('cannot reach broker');
  });

  it('onModuleDestroy disconnects a connected producer and is a no-op when never connected', async () => {
    const producer = new RewardEntryCreatedDlqProducer(buildConfigService());
    await producer.onModuleDestroy();
    expect(disconnect).not.toHaveBeenCalled();

    await producer.publish('a', { error: '1' });
    await producer.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
