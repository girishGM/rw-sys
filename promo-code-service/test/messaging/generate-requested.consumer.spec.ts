/**
 * T-PC-030. Fast, mocked-dependency unit tests for `GenerateRequestedConsumer.processMessage` —
 * every TC that doesn't need a real broker (TC-1..TC-10, TC-12..TC-14). The real-Redpanda round
 * trip (TC-15/TC-16) and the DLQ topic manual-publish verification step live in
 * `generate-requested.consumer.e2e-spec.ts` instead — same split `promo-code.controller.spec.ts`/
 * `grpc-server.e2e-spec.ts` (T-PC-031) already established for this project.
 *
 * Deviation from the task file's literal paths (`src/modules/kafka-consumer/**`,
 * `test/modules/kafka-consumer/**`): `project.config.json` grants this agent `src/messaging/**`/
 * `test/messaging/**`, not `src/modules/kafka-consumer/**` — the exact same class of deviation
 * `T-PC-031`'s own completion report already documented for its own task file
 * (`src/modules/grpc-server/**` vs. the granted `src/grpc/**`). See this task's completion report's
 * "Deviations from spec" for the full note, including the separate, flagged self-contradiction
 * between implementation note 6 and TC-8 that `generate-requested-payload.schema.ts`'s own header
 * documents.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  GenerateRequestedConsumer,
  type RawKafkaMessage,
} from '@/messaging/generate-requested.consumer';
import type { DlqProducerService } from '@/messaging/dlq-producer.service';
import type { PromoCodeGenerationService } from '@/modules/generation/promo-code-generation.service';
import type { GenerationResult } from '@/modules/generation/generation-result.types';
import {
  GENERATE_REQUESTED_CONSUMER_GROUP,
  GENERATE_REQUESTED_DLQ_TOPIC,
} from '@/messaging/kafka-consumer.config';

const CONSUMER_SOURCE_PATH = join(
  __dirname,
  '..',
  '..',
  'src',
  'messaging',
  'generate-requested.consumer.ts',
);

const successResult: GenerationResult = {
  status: 'SUCCESS',
  promoCodeId: 'pc-1',
  code: 'SAVE10-ABC123',
  rewardValueType: 'PERCENTAGE',
  rewardValue: '10.0000',
  rewardUnit: '%',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  errorCode: null,
  errorMessage: null,
};

function failureResult(
  errorCode: GenerationResult['errorCode'],
  errorMessage: string,
): GenerationResult {
  return {
    status: 'FAILED',
    promoCodeId: null,
    code: null,
    rewardValueType: null,
    rewardValue: null,
    rewardUnit: null,
    expiresAt: null,
    errorCode,
    errorMessage,
  } as GenerationResult;
}

function validEnvelope(
  overrides: {
    correlationId?: string;
    tenantId?: string;
    data?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    eventType: 'promo-code.generate.requested',
    eventVersion: '1.0',
    occurredAt: new Date().toISOString(),
    correlationId: overrides.correlationId ?? randomUUID(),
    tenantId: overrides.tenantId ?? randomUUID(),
    source: 'reward-redemption-service',
    data: overrides.data ?? {
      bindLevel: 'CAMPAIGN',
      bindRefId: randomUUID(),
      customerId: 'cust_8213',
      merchantId: randomUUID(),
      activityContext: { amount: '49.99', currency: 'USD', metadata: {} },
    },
  };
}

function toRawMessage(
  envelope: Record<string, unknown> | string,
  key: string | null,
): RawKafkaMessage {
  return {
    key,
    value: typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
  };
}

describe('T-PC-030 — GenerateRequestedConsumer (unit, mocked generation service/DLQ producer)', () => {
  function buildConsumer(
    generateCode: jest.Mock,
    publish: jest.Mock = jest.fn().mockResolvedValue(undefined),
    backoff: { baseMs?: number; maxMs?: number } = {},
  ): { consumer: GenerateRequestedConsumer; publish: jest.Mock } {
    const generationService = { generateCode } as unknown as PromoCodeGenerationService;
    const dlqProducer = { publish } as unknown as DlqProducerService;
    const configService = { get: () => undefined } as unknown as ConfigService;
    const consumer = new GenerateRequestedConsumer(
      generationService,
      dlqProducer,
      configService,
      backoff.baseMs ?? 1,
      backoff.maxMs ?? 5,
    );
    return { consumer, publish };
  }

  // TC-1
  it('TC-1: a valid message calls generateCode() with correctly mapped fields, transport="KAFKA"', async () => {
    const generateCode = jest.fn().mockResolvedValue(successResult);
    const { consumer } = buildConsumer(generateCode);
    const correlationId = randomUUID();
    const tenantId = randomUUID();
    const bindRefId = randomUUID();
    const merchantId = randomUUID();
    const envelope = validEnvelope({
      correlationId,
      tenantId,
      data: {
        bindLevel: 'CAMPAIGN',
        bindRefId,
        customerId: 'cust_8213',
        merchantId,
        activityContext: { amount: '49.99', currency: 'USD', metadata: { foo: 'bar' } },
      },
    });

    const outcome = await consumer.processMessage(toRawMessage(envelope, correlationId));

    expect(outcome).toBe('ACK');
    expect(generateCode).toHaveBeenCalledTimes(1);
    expect(generateCode).toHaveBeenCalledWith({
      correlationId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust_8213',
      merchantId,
      transport: 'KAFKA',
      activityContext: { amount: '49.99', currency: 'USD', metadata: { foo: 'bar' } },
    });
  });

  // TC-2
  it("TC-2: bindLevel='CAMPAIGN' is mapped through unchanged, generation proceeds", async () => {
    const generateCode = jest.fn().mockResolvedValue(successResult);
    const { consumer } = buildConsumer(generateCode);
    const envelope = validEnvelope({
      data: {
        bindLevel: 'CAMPAIGN',
        bindRefId: randomUUID(),
        customerId: 'cust_1',
      },
    });

    const outcome = await consumer.processMessage(toRawMessage(envelope, randomUUID()));

    expect(outcome).toBe('ACK');
    expect(generateCode).toHaveBeenCalledWith(expect.objectContaining({ bindLevel: 'CAMPAIGN' }));
  });

  // TC-3
  it('TC-3: a message missing correlationId is retried 3 times then routed to the DLQ', async () => {
    const generateCode = jest.fn();
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(generateCode, publish);
    const envelope = validEnvelope();
    delete (envelope as Record<string, unknown>).correlationId;

    const outcome = await consumer.processMessage(toRawMessage(envelope, 'some-key'));

    expect(outcome).toBe('DLQ');
    expect(generateCode).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    const [topic, key, dlqMessage] = publish.mock.calls[0];
    expect(topic).toBe(GENERATE_REQUESTED_DLQ_TOPIC);
    expect(key).toBe('some-key');
    expect(dlqMessage.eventId).toBe(envelope.eventId);
    expect(typeof dlqMessage.error).toBe('string');
    expect(dlqMessage.error).toContain('correlationId');
    expect(typeof dlqMessage.failedAt).toBe('string');
  });

  // TC-4
  it('TC-4: malformed JSON body is retried 3 times then routed to the DLQ', async () => {
    const generateCode = jest.fn();
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(generateCode, publish);

    const outcome = await consumer.processMessage(toRawMessage('{not-json', 'raw-key'));

    expect(outcome).toBe('DLQ');
    expect(generateCode).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    const [, key, dlqMessage] = publish.mock.calls[0];
    expect(key).toBe('raw-key');
    expect(dlqMessage.raw).toBe('{not-json');
    expect(typeof dlqMessage.error).toBe('string');
    expect(typeof dlqMessage.failedAt).toBe('string');
  });

  // TC-5
  it('TC-5: DLQ payload shape contains the original envelope + error + failedAt', async () => {
    const generateCode = jest.fn();
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(generateCode, publish);
    const envelope = validEnvelope();
    delete (envelope as Record<string, unknown>).tenantId;

    await consumer.processMessage(toRawMessage(envelope, randomUUID()));

    const [, , dlqMessage] = publish.mock.calls[0];
    expect(dlqMessage).toEqual(
      expect.objectContaining({
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        eventVersion: envelope.eventVersion,
        occurredAt: envelope.occurredAt,
        source: envelope.source,
        data: envelope.data,
        error: expect.any(String),
        failedAt: expect.any(String),
      }),
    );
    expect(new Date(dlqMessage.failedAt as string).toISOString()).toBe(dlqMessage.failedAt);
  });

  // TC-6
  it("TC-6: a CONFIG_NOT_BOUND FAILED result is acknowledged normally — not retried, not DLQ'd", async () => {
    const generateCode = jest
      .fn()
      .mockResolvedValue(failureResult('CONFIG_NOT_BOUND', 'no binding'));
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(generateCode, publish);

    const outcome = await consumer.processMessage(toRawMessage(validEnvelope(), randomUUID()));

    expect(outcome).toBe('ACK');
    expect(generateCode).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-7
  it("TC-7: a GENERATION_EXHAUSTED FAILED result is acknowledged normally — not DLQ'd", async () => {
    const generateCode = jest
      .fn()
      .mockResolvedValue(failureResult('GENERATION_EXHAUSTED', 'exhausted retries'));
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(generateCode, publish);

    const outcome = await consumer.processMessage(toRawMessage(validEnvelope(), randomUUID()));

    expect(outcome).toBe('ACK');
    expect(generateCode).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-8
  it("TC-8: a message missing data.customerId is passed through to generateCode() (INVALID_REQUEST case), not DLQ'd at the adapter level", async () => {
    const generateCode = jest
      .fn()
      .mockResolvedValue(failureResult('INVALID_REQUEST', 'customerId is required'));
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(generateCode, publish);
    const envelope = validEnvelope({
      data: { bindLevel: 'CAMPAIGN', bindRefId: randomUUID() },
    });

    const outcome = await consumer.processMessage(toRawMessage(envelope, randomUUID()));

    expect(outcome).toBe('ACK');
    expect(generateCode).toHaveBeenCalledTimes(1);
    expect(generateCode).toHaveBeenCalledWith(expect.objectContaining({ customerId: undefined }));
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-9
  it('TC-9: two messages with the same correlationId (simulated redelivery) both reach generateCode() — no adapter-level dedup', async () => {
    const generateCode = jest.fn().mockResolvedValue(successResult);
    const { consumer } = buildConsumer(generateCode);
    const correlationId = randomUUID();
    const envelope = validEnvelope({ correlationId });

    await consumer.processMessage(toRawMessage(envelope, correlationId));
    await consumer.processMessage(toRawMessage(envelope, correlationId));

    expect(generateCode).toHaveBeenCalledTimes(2);
  });

  // TC-10
  it('TC-10: the consumer group name is exactly "promo-code-service.generate-requested"', () => {
    expect(GENERATE_REQUESTED_CONSUMER_GROUP).toBe('promo-code-service.generate-requested');
  });

  // TC-12
  it("TC-12: a transient error thrown mid-processing is retried per the bounded retry policy, not immediately DLQ'd", async () => {
    const generateCode = jest
      .fn()
      .mockRejectedValueOnce(new Error('simulated DB connection blip'))
      .mockResolvedValueOnce(successResult);
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(generateCode, publish, { baseMs: 1, maxMs: 5 });

    const outcome = await consumer.processMessage(toRawMessage(validEnvelope(), randomUUID()));

    expect(outcome).toBe('ACK');
    expect(generateCode).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-13
  it('TC-13: retry count exhausted for a genuinely malformed message — exactly 3 attempts, exponential backoff timing present', async () => {
    const generateCode = jest.fn();
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(generateCode, publish, { baseMs: 20, maxMs: 1000 });

    const start = Date.now();
    const outcome = await consumer.processMessage(toRawMessage('{not-json', 'key'));
    const elapsedMs = Date.now() - start;

    expect(outcome).toBe('DLQ');
    // 2 backoff waits between 3 attempts: 20ms + 40ms = 60ms minimum (exponential doubling).
    expect(elapsedMs).toBeGreaterThanOrEqual(55);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('TC-13 (adjacent): a transient error retried past the ceiling still routes to the DLQ, not an unhandled rejection', async () => {
    const generateCode = jest.fn().mockRejectedValue(new Error('persistent DB outage'));
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(generateCode, publish, { baseMs: 1, maxMs: 5 });

    const outcome = await consumer.processMessage(toRawMessage(validEnvelope(), randomUUID()));

    expect(outcome).toBe('DLQ');
    expect(generateCode).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledTimes(1);
    const [, , dlqMessage] = publish.mock.calls[0];
    expect(dlqMessage.error).toContain('persistent DB outage');
  });
});

describe('T-PC-030 — R10 code-inspection guard (TC-14)', () => {
  const consumerSource = readFileSync(CONSUMER_SOURCE_PATH, 'utf8');

  // TC-14: no collision-retry/binding-resolution/idempotency logic in the transport adapter.
  // Scans for the actual symbols that logic would require, not just a comment mentioning them —
  // this file's own extensive header prose (which explains R10 compliance) must not trip it.
  it('TC-14: the consumer never references collision-retry/binding-resolution/idempotency internals', () => {
    const forbiddenSymbols = [
      'maxRetryAttempts',
      'CodeGenerator',
      'CampaignBindingService',
      'resolveActiveBinding',
      'findByCorrelationId',
      'isCodeCollision',
      'isCorrelationConflict',
      'INSERT INTO',
      'sequelize.transaction',
    ];
    for (const symbol of forbiddenSymbols) {
      expect(consumerSource).not.toContain(symbol);
    }
  });

  it('TC-14 (adjacent): the consumer only ever calls generateCode() on the injected service, never re-implements it', () => {
    const generateCodeCallSites =
      consumerSource.match(/this\.generationService\.generateCode\(/g) ?? [];
    expect(generateCodeCallSites).toHaveLength(1);
  });
});
