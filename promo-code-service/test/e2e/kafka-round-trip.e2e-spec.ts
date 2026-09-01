/**
 * T-PC-040. Full Kafka round trip: a real `kafkajs` producer publishes a real
 * `promo-code.generate.requested.v1` message onto the real Redpanda broker
 * (`docker-compose.yml`, T-PC-001); the real, listening `GenerateRequestedConsumer` (T-PC-030)
 * consumes it and calls the real `PromoCodeGenerationService` (T-PC-021), which commits a real
 * `promo_code` + `promo_code_outbox` row against the real, already-migrated `promo_code` schema;
 * the real `OutboxPublisherWorker` (T-PC-022, driven via `withOutboxPump` — see
 * `test/e2e/setup/e2e-test-app.ts`'s own header for why autostart stays off) publishes the real
 * result onto `promo-code.generate.result.v1`, consumed here by a real, independent `kafkajs`
 * consumer. Every seam between T-PC-030/T-PC-021/T-PC-022 is exercised in the same test —
 * `AGENT-PROTOCOL.md` §3's "assert the observable property, not the implementation string": this
 * suite asserts the actual published message, not that some internal method was called.
 *
 * **Deviation from the task file's literal Verification step 1 command (`npm run test:e2e`)**: no
 * `test:e2e` script exists in `package.json` (same precedent already accepted on T-PC-011/T-PC-012/
 * T-PC-021/T-PC-030/T-PC-031's own reviews — `package.json` is outside every agent's file scope
 * except `agent-promo-foundation`'s). `npm test -- test/e2e` runs this file via the single
 * `testRegex` that already matches `.e2e-spec.ts` files under `test/`. See this task's completion
 * report for the full list of such deviations.
 *
 * **Requires a running Redpanda** (`docker compose up -d redpanda` from `promo-code-service/`) and
 * the real local Postgres 16 server (root `CLAUDE.md`) — this suite is real infrastructure, not
 * mocked, by design.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { GENERATE_REQUESTED_TOPIC } from '@/messaging/kafka-consumer.config';
import { GENERATE_RESULT_TOPIC } from '@/modules/generation/promo-code-generation.constants';
import {
  E2ETestHarness,
  collectKafkaMessages,
  waitForKafkaMessage,
  withOutboxPump,
} from './setup/e2e-test-app';

jest.setTimeout(90_000);

describe('T-PC-040 — Kafka round trip (real Redpanda, real Postgres) (e2e)', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await E2ETestHarness.create();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  function activityData(customerId: string, bindRefId: string): Record<string, unknown> {
    return {
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId,
      merchantId: null,
      activityContext: { amount: '25.00', currency: 'USD', metadata: {} },
    };
  }

  // TC-1
  it('TC-1: publish generate.requested -> consume generate.result with the exact §5 envelope+data shape', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'KAFKA1-' });
    const correlationId = randomUUID();

    const resultMessage = await withOutboxPump(harness, tenantId, correlationId, async () => {
      await harness.publishGenerateRequested(
        GENERATE_REQUESTED_TOPIC,
        correlationId,
        tenantId,
        activityData('cust-tc1', bindRefId),
      );
      return waitForKafkaMessage(GENERATE_RESULT_TOPIC, 60_000, (key) => key === correlationId);
    });

    // Envelope shape (`02-KAFKA-CONTRACTS.md` §2).
    expect(typeof resultMessage.eventId).toBe('string');
    expect(resultMessage.eventType).toBe('promo-code.generate.result');
    expect(resultMessage.eventVersion).toBe('1.0');
    expect(typeof resultMessage.occurredAt).toBe('string');
    expect(resultMessage.correlationId).toBe(correlationId);
    expect(resultMessage.tenantId).toBe(tenantId);
    expect(resultMessage.source).toBe('promo-code-service');

    // `data` shape (`02-KAFKA-CONTRACTS.md` §5).
    const data = resultMessage.data as Record<string, unknown>;
    expect(data.status).toBe('SUCCESS');
    expect(typeof data.promoCodeId).toBe('string');
    expect((data.code as string).startsWith('KAFKA1-')).toBe(true);
    expect(data.rewardValueType).toBe('FIXED_AMOUNT');
    expect(data.rewardValue).toBe('5.0000');
    expect(data.rewardUnit).toBe('USD');
    expect(typeof data.expiresAt).toBe('string');
    expect(data.errorCode).toBeNull();
    expect(data.errorMessage).toBeNull();

    // The `promo_code` row this result describes really exists (not just an in-memory result).
    const rows = await harness.sequelize.query<{ id: string; code: string }>(
      `SELECT id, code FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(data.promoCodeId);
    expect(rows[0].code).toBe(data.code);
  });

  // TC-4 (also covers TC-8: exactly-once processing by the running consumer group)
  it('TC-4/TC-8: redelivering the same correlationId produces exactly one promo_code row and exactly one result message', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'KAFKA4-' });
    const correlationId = randomUUID();
    const data = activityData('cust-tc4', bindRefId);

    const firstResult = await withOutboxPump(harness, tenantId, correlationId, async () => {
      await harness.publishGenerateRequested(
        GENERATE_REQUESTED_TOPIC,
        correlationId,
        tenantId,
        data,
      );
      return waitForKafkaMessage(GENERATE_RESULT_TOPIC, 60_000, (key) => key === correlationId);
    });

    // Redelivery: a second `generate.requested` message for the identical correlationId (a new
    // `eventId`, same `correlationId` — exactly `02-KAFKA-CONTRACTS.md` §2's own redelivery shape).
    await harness.publishGenerateRequested(GENERATE_REQUESTED_TOPIC, correlationId, tenantId, data);

    // Give the consumer group time to actually process the redelivered message (T-PC-021's own
    // idempotency check short-circuits before any new outbox row is ever created — implementation
    // note 2 — so there is nothing further for `withOutboxPump` to publish for this correlationId).
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const rows = await harness.sequelize.query<{ id: string }>(
      `SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
    );
    expect(rows).toHaveLength(1);

    // Only the one result message this correlationId ever produced exists on the topic — watch
    // the entire topic for a bounded window (not just "the first match", which would prove
    // nothing about a possible second one) and assert there is exactly one, byte-for-byte the
    // same as the first.
    const messages = await collectKafkaMessages(
      GENERATE_RESULT_TOPIC,
      5_000,
      (key) => key === correlationId,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(firstResult);
  });
});
