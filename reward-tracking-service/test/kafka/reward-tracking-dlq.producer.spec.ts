/**
 * T-RTS-012 — `RewardTrackingDlqProducer`, exercised against a mocked `kafkajs` module (no real
 * broker needed to prove lazy-connect/publish/error-propagation behavior) — mirrors
 * `reward-redemption-service`'s own `reward-entry-created-dlq.producer.spec.ts` (T-RR-012,
 * confirmed by direct read) shape.
 */
import type { ConfigService } from '@nestjs/config';

const producerConnect = jest.fn().mockResolvedValue(undefined);
const producerSend = jest.fn().mockResolvedValue(undefined);
const producerDisconnect = jest.fn().mockResolvedValue(undefined);
const producerFactory = jest.fn(() => ({
  connect: producerConnect,
  send: producerSend,
  disconnect: producerDisconnect,
}));

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({ producer: producerFactory })),
  logLevel: { NOTHING: 0 },
}));

import {
  RewardTrackingDlqProducer,
  REWARD_TRACKING_COMPLETED_DLQ_TOPIC,
} from '@/kafka/reward-tracking-dlq.producer';
import type { Config } from '@/config/config.schema';

function buildConfigService(): ConfigService<Config, true> {
  return { get: () => 'localhost:9095' } as unknown as ConfigService<Config, true>;
}

describe('T-RTS-012 — RewardTrackingDlqProducer', () => {
  beforeEach(() => {
    producerConnect.mockClear().mockResolvedValue(undefined);
    producerSend.mockClear().mockResolvedValue(undefined);
    producerDisconnect.mockClear().mockResolvedValue(undefined);
    producerFactory.mockClear();
  });

  it('connects lazily — construction alone never opens a broker connection', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- constructed only to prove no
    // side effect happens at construction time (T-RTS-012's own no-eager-connect discipline).
    const _producer = new RewardTrackingDlqProducer(buildConfigService());
    expect(producerConnect).not.toHaveBeenCalled();
  });

  it('publish() connects once, then sends to the fixed DLQ topic with the given key/message', async () => {
    const producer = new RewardTrackingDlqProducer(buildConfigService());

    await producer.publish('cust-1', { error: 'campaignCode is required', failedAt: 'x' });
    await producer.publish('cust-1', { error: 'another', failedAt: 'y' });

    expect(producerConnect).toHaveBeenCalledTimes(1);
    expect(producerSend).toHaveBeenNthCalledWith(1, {
      topic: REWARD_TRACKING_COMPLETED_DLQ_TOPIC,
      messages: [
        {
          key: 'cust-1',
          value: JSON.stringify({ error: 'campaignCode is required', failedAt: 'x' }),
        },
      ],
    });
  });

  it('publish() with a null key sends the message with an undefined key', async () => {
    const producer = new RewardTrackingDlqProducer(buildConfigService());

    await producer.publish(null, { error: 'x', failedAt: 'y' });

    expect(producerSend).toHaveBeenCalledWith({
      topic: REWARD_TRACKING_COMPLETED_DLQ_TOPIC,
      messages: [{ key: undefined, value: JSON.stringify({ error: 'x', failedAt: 'y' }) }],
    });
  });

  it('publish() throws when the underlying send fails, never swallowing the error', async () => {
    producerSend.mockRejectedValueOnce(new Error('broker unreachable'));
    const producer = new RewardTrackingDlqProducer(buildConfigService());

    await expect(producer.publish('cust-1', { error: 'x', failedAt: 'y' })).rejects.toThrow(
      'broker unreachable',
    );
  });

  it('onModuleDestroy disconnects a connected producer, and is a safe no-op if never connected', async () => {
    const connected = new RewardTrackingDlqProducer(buildConfigService());
    await connected.publish('cust-1', { error: 'x', failedAt: 'y' });
    await connected.onModuleDestroy();
    expect(producerDisconnect).toHaveBeenCalledTimes(1);

    const neverConnected = new RewardTrackingDlqProducer(buildConfigService());
    await neverConnected.onModuleDestroy();
    expect(producerDisconnect).toHaveBeenCalledTimes(1);
  });
});
