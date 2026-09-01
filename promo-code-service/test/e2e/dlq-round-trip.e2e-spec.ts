/**
 * T-PC-040. DLQ round trip: a genuinely malformed message (real broken JSON, not a mock claiming
 * it would fail) is published onto the real `promo-code.generate.requested.v1` topic; the real,
 * listening `GenerateRequestedConsumer` (T-PC-030) runs its full bounded-retry pipeline against it
 * and, once exhausted, publishes it onto `promo-code.generate.requested.v1.dlq` with the exact
 * shape `02-KAFKA-CONTRACTS.md` §6 documents. Implementation note 4: this suite also confirms the
 * retry attempts actually elapse (observable as wall-clock delay from the consumer's own
 * exponential backoff between attempts), not that the message is routed to the DLQ instantly on
 * the first failure.
 *
 * **Deviation from the task file's literal Verification step 1 command (`npm run test:e2e`)**: no
 * `test:e2e` script exists in `package.json` — same precedent as every sibling spec in this suite
 * (see `kafka-round-trip.e2e-spec.ts`'s own header).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  GENERATE_REQUESTED_DLQ_TOPIC,
  GENERATE_REQUESTED_TOPIC,
  MAX_PROCESSING_ATTEMPTS,
} from '@/messaging/kafka-consumer.config';
import { E2ETestHarness, waitForKafkaMessage } from './setup/e2e-test-app';

jest.setTimeout(60_000);

describe('T-PC-040 — DLQ round trip (real Redpanda) (e2e)', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await E2ETestHarness.create();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  // TC-5 (broken-JSON case)
  it('TC-5: a message that is not valid JSON lands on the DLQ topic with the documented §6 shape, after real retries elapse', async () => {
    const key = `t-pc-040-dlq-broken-json-${randomUUID()}`;
    const publishedAt = Date.now();

    await harness.producer.send({
      topic: GENERATE_REQUESTED_TOPIC,
      messages: [{ key, value: '{this is not valid json, at all' }],
    });

    const dlqMessage = await waitForKafkaMessage(
      GENERATE_REQUESTED_DLQ_TOPIC,
      45_000,
      (msgKey) => msgKey === key,
    );
    const observedDelayMs = Date.now() - publishedAt;

    expect(dlqMessage.raw).toBe('{this is not valid json, at all');
    expect(typeof dlqMessage.error).toBe('string');
    expect(typeof dlqMessage.failedAt).toBe('string');
    expect(() => new Date(dlqMessage.failedAt as string).toISOString()).not.toThrow();

    // `MAX_PROCESSING_ATTEMPTS` (3) attempts means 2 backoff waits actually elapsed before this
    // message reached the DLQ — proving the retry window was observed, not skipped
    // (implementation note 4). A near-zero delay would mean the consumer gave up on the very
    // first attempt, contradicting `02-KAFKA-CONTRACTS.md` §6's "bounded retry... before routing
    // to the DLQ".
    expect(MAX_PROCESSING_ATTEMPTS).toBe(3);
    expect(observedDelayMs).toBeGreaterThanOrEqual(300);
  });

  // TC-5 (structurally-invalid-envelope case) — a well-formed JSON object that still fails
  // `envelope.schema.ts`'s strict validation (missing `correlationId`), preserving the original
  // envelope fields verbatim in the DLQ payload (implementation note 5) rather than falling back
  // to the raw-string shape the broken-JSON case above needs.
  it('TC-5: a structurally invalid envelope (missing correlationId) lands on the DLQ preserving the original fields', async () => {
    const key = `t-pc-040-dlq-bad-envelope-${randomUUID()}`;
    const malformedEnvelope = {
      eventId: randomUUID(),
      eventType: 'promo-code.generate.requested',
      eventVersion: '1.0',
      occurredAt: new Date().toISOString(),
      // `correlationId` deliberately omitted — `envelopeSchema` requires it.
      tenantId: randomUUID(),
      source: 'reward-redemption-service',
      data: { bindLevel: 'CAMPAIGN', bindRefId: randomUUID(), customerId: 'cust-dlq-tc5b' },
    };

    await harness.producer.send({
      topic: GENERATE_REQUESTED_TOPIC,
      messages: [{ key, value: JSON.stringify(malformedEnvelope) }],
    });

    const dlqMessage = await waitForKafkaMessage(
      GENERATE_REQUESTED_DLQ_TOPIC,
      45_000,
      (msgKey) => msgKey === key,
    );

    expect(dlqMessage.eventId).toBe(malformedEnvelope.eventId);
    expect(dlqMessage.tenantId).toBe(malformedEnvelope.tenantId);
    expect(dlqMessage.source).toBe('reward-redemption-service');
    expect(dlqMessage.correlationId).toBeUndefined();
    expect(typeof dlqMessage.error).toBe('string');
    expect(dlqMessage.error as string).toContain('correlationId');
    expect(typeof dlqMessage.failedAt).toBe('string');
  });
});
