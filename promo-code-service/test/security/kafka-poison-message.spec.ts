/**
 * T-PC-041. Cross-cutting Kafka poison-message/resource-exhaustion pass over
 * `promo-code.generate.requested.v1` (`02-KAFKA-CONTRACTS.md` §6), against the real Redpanda
 * broker (`docker-compose.yml`) and the real, listening `GenerateRequestedConsumer` (T-PC-030) —
 * reusing `E2ETestHarness` (`test/e2e/setup/e2e-test-app.ts`, T-PC-040's own owned file — imported
 * read-only here, never edited, per R8) for the same three-transport composition root every other
 * `test/e2e/**` spec already boots.
 *
 * T-PC-030's own `generate-requested.consumer.spec.ts` (mocked) and T-PC-040's own
 * `dlq-round-trip.e2e-spec.ts` (real broker) already prove TC-7's core claim — a malformed
 * envelope (missing `correlationId`) is retried a bounded number of times and lands on the DLQ
 * with the documented shape. Confirmed by reading both files directly (not assumed from prose).
 * What this file adds, per this task's own note 1 ("confirm those tests actually exist... and add
 * the tests that only make sense cross-cutting"):
 *
 *  1. **Resilience, not just correctness**: after a poison message is DLQ'd, the *same, still-running*
 *     consumer process must go on to process a subsequent, well-formed message normally — proving
 *     a poison message never crashes or wedges the consumer loop. Neither T-PC-030's mocked suite
 *     (which never runs a real `eachMessage` loop across multiple messages) nor T-PC-040's DLQ
 *     round trip (which only asserts the DLQ side of one single message) exercises this.
 *  2. **TC-8, `activityContext.metadata` size**: `02-KAFKA-CONTRACTS.md` §3 and
 *     `generate-requested-payload.schema.ts` both describe this field as free-form/passed through
 *     untouched, with no explicit application-level size bound — this suite confirms that
 *     "untouched" does not also mean "unbounded" in practice: a moderately large payload is
 *     processed normally (bounded, does not hang/crash), and a genuinely oversized one is rejected
 *     at the real Kafka producer/broker layer before this service's own consumer ever sees it —
 *     i.e. there is a real ceiling, just enforced by the transport rather than by application code.
 *     Recorded as a hardening note (not a blocking defect) in this task's own security checklist:
 *     no explicit `maxRequestSize`/broker `message.max.bytes` is configured anywhere in this
 *     project — the ceiling that exists today is each library's own undeclared default, not a
 *     value this service's own code chose deliberately.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import {
  GENERATE_REQUESTED_DLQ_TOPIC,
  GENERATE_REQUESTED_TOPIC,
} from '@/messaging/kafka-consumer.config';
import { GENERATE_RESULT_TOPIC } from '@/modules/generation/promo-code-generation.constants';
import { E2ETestHarness, waitForKafkaMessage, withOutboxPump } from '../e2e/setup/e2e-test-app';

jest.setTimeout(90_000);

describe('T-PC-041 — Kafka poison-message / resource-exhaustion sweep (real Redpanda) (e2e)', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await E2ETestHarness.create();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  function envelope(
    correlationId: string,
    tenantId: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      eventId: randomUUID(),
      eventType: 'promo-code.generate.requested',
      eventVersion: '1.0',
      occurredAt: new Date().toISOString(),
      correlationId,
      tenantId,
      source: 'reward-redemption-service',
      data,
    };
  }

  // TC-7 (resilience): the consumer survives a poison message and keeps processing.
  it('TC-7: a poison message (missing correlationId) is DLQ’d without wedging the consumer — a subsequent valid message still succeeds', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'POISON1-' });

    const poisonKey = `t-pc-041-poison-${randomUUID()}`;
    const malformed = envelope('placeholder', tenantId, {
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-poison',
    });
    delete (malformed as Record<string, unknown>).correlationId;
    await harness.producer.send({
      topic: GENERATE_REQUESTED_TOPIC,
      messages: [{ key: poisonKey, value: JSON.stringify(malformed) }],
    });

    const dlqMessage = await waitForKafkaMessage(
      GENERATE_REQUESTED_DLQ_TOPIC,
      45_000,
      (key) => key === poisonKey,
    );
    expect(dlqMessage.correlationId).toBeUndefined();
    expect(typeof dlqMessage.error).toBe('string');

    // The consumer process is the exact same one that just DLQ'd the poison message above — no
    // restart, no new harness. A well-formed message right after it must still succeed normally.
    const correlationId = randomUUID();
    const resultMessage = await withOutboxPump(harness.outboxWorker, async () => {
      await harness.publishGenerateRequested(GENERATE_REQUESTED_TOPIC, correlationId, tenantId, {
        bindLevel: 'CAMPAIGN',
        bindRefId,
        customerId: 'cust-after-poison',
        merchantId: null,
      });
      return waitForKafkaMessage(GENERATE_RESULT_TOPIC, 60_000, (key) => key === correlationId);
    });

    const data = resultMessage.data as Record<string, unknown>;
    expect(data.status).toBe('SUCCESS');
    expect((data.code as string).startsWith('POISON1-')).toBe(true);

    const rows = await harness.sequelize.query<{ id: string }>(
      `SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
    );
    expect(rows).toHaveLength(1);
  });

  // TC-8: a moderately large (but realistic) metadata payload is processed normally — bounded
  // work, not an unbounded-memory path.
  it('TC-8: a large-but-bounded activityContext.metadata payload is processed normally, not hung', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'META1-' });
    const correlationId = randomUUID();
    // ~200KB of JSON — comfortably inside every default Kafka/Redpanda message-size ceiling, but
    // far larger than any legitimate "traceability metadata" payload this contract's own example
    // (02-KAFKA-CONTRACTS.md §3: `{}`) implies.
    const largeMetadata: Record<string, string> = {};
    for (let i = 0; i < 4000; i += 1) {
      largeMetadata[`key_${i}`] = 'x'.repeat(40);
    }

    const resultMessage = await withOutboxPump(harness.outboxWorker, async () => {
      await harness.publishGenerateRequested(GENERATE_REQUESTED_TOPIC, correlationId, tenantId, {
        bindLevel: 'CAMPAIGN',
        bindRefId,
        customerId: 'cust-large-metadata',
        merchantId: null,
        activityContext: { amount: '10.00', currency: 'USD', metadata: largeMetadata },
      });
      return waitForKafkaMessage(GENERATE_RESULT_TOPIC, 60_000, (key) => key === correlationId);
    });

    const data = resultMessage.data as Record<string, unknown>;
    expect(data.status).toBe('SUCCESS');
    expect((data.code as string).startsWith('META1-')).toBe(true);
  });

  // TC-8 (ceiling proof): a genuinely oversized message is rejected by the real Kafka producer/
  // broker layer itself — proving "passed through untouched" does not also mean "no ceiling
  // exists anywhere in this pipeline", even though this service's own application code declares
  // no explicit bound of its own (recorded as a hardening note in the checklist, not a defect:
  // the ceiling is real, just implicit).
  it('TC-8 (ceiling): a multi-megabyte message is rejected at the real broker/producer layer, never silently accepted', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'META2-' });
    const correlationId = randomUUID();
    // ~5MB of metadata — beyond Kafka/Redpanda's conventional single-message default ceiling
    // (historically 1MB-class on the broker side; kafkajs's own producer also refuses to build a
    // request this large without an explicit, deliberately-raised `maxRequestSize`, which nothing
    // in this project's own producer wiring sets).
    const oversizedMetadata = { blob: 'y'.repeat(5 * 1024 * 1024) };
    const message = envelope(correlationId, tenantId, {
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-oversized-metadata',
      merchantId: null,
      activityContext: { amount: '10.00', currency: 'USD', metadata: oversizedMetadata },
    });

    await expect(
      harness.producer.send({
        topic: GENERATE_REQUESTED_TOPIC,
        messages: [{ key: correlationId, value: JSON.stringify(message) }],
      }),
    ).rejects.toBeTruthy();

    // Never processed — no promo_code row exists for a message the broker itself never accepted.
    const rows = await harness.sequelize.query<{ id: string }>(
      `SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
    );
    expect(rows).toHaveLength(0);
  });
});
