/**
 * T-PC-030. Real round trip: a real `kafkajs` producer publishes onto a real Redpanda broker
 * (`docker-compose.yml`'s `redpanda` service, T-PC-001), consumed by a real, listening
 * `GenerateRequestedConsumer.start()` backed by the real, already-migrated `promo_code` schema on
 * the real Postgres 16 server (root `CLAUDE.md`) — same "assert the observable property, not the
 * implementation string" discipline `grpc-server.e2e-spec.ts` (T-PC-031) and
 * `outbox-publisher.worker.spec.ts` (T-PC-022) already established for this project
 * (`AGENT-PROTOCOL.md` §3): only a real broker round trip can actually prove TC-15/TC-16, not a
 * mocked transport.
 *
 * Deviation from the task file's literal Verification step 2 command (`npm run test:e2e --
 * kafka-consumer`): no `test:e2e` script exists in `package.json` (same precedent T-PC-011/
 * T-PC-021/T-PC-031 already established) — `npm test -- messaging` runs this file via the single
 * `testRegex` that already matches both `.spec.ts` and `.e2e-spec.ts`.
 *
 * **Requires a running Redpanda** (`docker compose up -d redpanda` from `promo-code-service/`,
 * `KAFKA_BROKERS=localhost:9092`) — this suite is real infrastructure, not mocked, by design.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Kafka, logLevel, type Admin, type Consumer, type Producer } from 'kafkajs';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ConfigModule } from '@/config/config.module';
import { KafkaConsumerModule } from '@/messaging/kafka-consumer.module';
import { GenerateRequestedConsumer } from '@/messaging/generate-requested.consumer';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import {
  GENERATE_REQUESTED_DLQ_TOPIC,
  GENERATE_REQUESTED_TOPIC,
} from '@/messaging/kafka-consumer.config';
import { createAppTestConnection } from '../config/support/app-connection';

jest.setTimeout(60_000);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`pollUntil: timed out after ${timeoutMs}ms`);
    }
    await wait(intervalMs);
  }
}

describe('T-PC-030 — GenerateRequestedConsumer (real Redpanda, real Postgres) (e2e)', () => {
  let moduleRef: TestingModule;
  let consumer: GenerateRequestedConsumer;
  let promoCodeConfigRepository: PromoCodeConfigRepository;
  let bindingService: CampaignBindingService;
  let sequelize: Sequelize;
  let producer: Producer;
  const tenantIds: string[] = [];
  const brokers = String(process.env.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((b) => b.trim());

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KafkaConsumerModule],
    }).compile();
    await moduleRef.init();

    consumer = moduleRef.get(GenerateRequestedConsumer);
    promoCodeConfigRepository = moduleRef.get(PromoCodeConfigRepository);
    bindingService = moduleRef.get(CampaignBindingService);
    await consumer.start();

    sequelize = createAppTestConnection();
    await sequelize.authenticate();

    const kafka = new Kafka({
      clientId: 't-pc-030-e2e-producer',
      brokers,
      logLevel: logLevel.NOTHING,
    });
    producer = kafka.producer();
    await producer.connect();
  });

  afterAll(async () => {
    await producer.disconnect();
    await consumer.stop();
    // Closing the testing module runs `DlqProducerService.onModuleDestroy` (disconnects the
    // lazily-connected DLQ producer opened by TC-16) — without this, that socket is left open
    // and Jest reports "A worker process has failed to exit gracefully" for this suite.
    await moduleRef.close();
    for (const tenantId of tenantIds) {
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_outbox
           WHERE promo_code_id IN (SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId)`,
        { replacements: { tenantId } },
      );
      await sequelize.query('DELETE FROM promo_code.promo_code WHERE tenant_id = :tenantId', {
        replacements: { tenantId },
      });
      await sequelize.query(
        'DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
      await sequelize.query(
        'DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
    }
    await sequelize.close();
  });

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  async function seedBoundConfig(): Promise<{ tenantId: string; bindRefId: string }> {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-030 e2e config ${randomUUID()}`,
      codePrefix: 'KAFKA-',
      codePostfix: null,
      codeLength: 10,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: true,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: 5,
      rewardUnit: 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: 30,
      createdBy: actorId,
    });
    const bindRefId = randomUUID();
    await bindingService.bind({
      promoCodeConfigId: config.id,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      boundBy: actorId,
    });
    return { tenantId, bindRefId };
  }

  function envelope(correlationId: string, tenantId: string, data: Record<string, unknown>) {
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

  /** Consumes `GENERATE_REQUESTED_DLQ_TOPIC` from the beginning, looking for `key`. */
  async function waitForDlqMessage(
    key: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const kafka = new Kafka({
      clientId: 't-pc-030-e2e-dlq-reader',
      brokers,
      logLevel: logLevel.NOTHING,
    });
    const dlqConsumer: Consumer = kafka.consumer({ groupId: `t-pc-030-e2e-dlq-${randomUUID()}` });
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topic: GENERATE_REQUESTED_DLQ_TOPIC, fromBeginning: true });

    let found: Record<string, unknown> | null = null;
    const runPromise = dlqConsumer.run({
      eachMessage: async ({ message }) => {
        if (found !== null) {
          return;
        }
        if ((message.key ? message.key.toString() : null) === key && message.value) {
          found = JSON.parse(message.value.toString()) as Record<string, unknown>;
        }
      },
    });

    try {
      return await pollUntil(() => Promise.resolve(found), timeoutMs, 250);
    } finally {
      await dlqConsumer.stop();
      await dlqConsumer.disconnect();
      await runPromise.catch(() => undefined);
    }
  }

  // TC-11
  it(
    'TC-11: a message keyed by correlationId, redelivered, lands on the same partition ' +
      'both times (real broker, not asserted at the adapter unit level)',
    async () => {
      // A dedicated multi-partition topic, distinct from `GENERATE_REQUESTED_TOPIC` — this test
      // proves the general kafkajs default-partitioner property implementation note 4 describes
      // ("a retry of the same request lands on the same partition"), which is a property of the
      // producer's own keying (reward-redemption-service, not built here), not of this consumer's
      // code. A single-partition topic would make the assertion vacuously true, so this test
      // creates its own multi-partition topic via the admin API rather than relying on however
      // many partitions Redpanda's auto-topic-creation happens to give `GENERATE_REQUESTED_TOPIC`.
      const admin: Admin = new Kafka({
        clientId: 't-pc-030-e2e-tc11-admin',
        brokers,
        logLevel: logLevel.NOTHING,
      }).admin();
      await admin.connect();
      const topic = `t-pc-030-tc11-partitioning-${randomUUID()}`;
      try {
        await admin.createTopics({
          topics: [{ topic, numPartitions: 6, replicationFactor: 1 }],
          waitForLeaders: true,
        });

        const correlationId = randomUUID();
        const [firstSend] = await producer.send({
          topic,
          messages: [{ key: correlationId, value: JSON.stringify({ attempt: 1 }) }],
        });
        // Simulated redelivery of the same request after a consumer crash (TC-9's own scenario,
        // here observed at the partition-assignment level instead of the adapter level).
        const [secondSend] = await producer.send({
          topic,
          messages: [{ key: correlationId, value: JSON.stringify({ attempt: 2 }) }],
        });

        expect(firstSend.partition).toBe(secondSend.partition);
      } finally {
        await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
        await admin.disconnect();
      }
    },
  );

  // TC-15
  it('TC-15: a valid generate.requested message produces a real promo_code row matching the request', async () => {
    const { tenantId, bindRefId } = await seedBoundConfig();
    const correlationId = randomUUID();
    const message = envelope(correlationId, tenantId, {
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-t-pc-030-tc15',
      merchantId: null,
      activityContext: { amount: '25.00', currency: 'USD', metadata: {} },
    });

    await producer.send({
      topic: GENERATE_REQUESTED_TOPIC,
      messages: [{ key: correlationId, value: JSON.stringify(message) }],
    });

    const row = await pollUntil(async () => {
      const rows = await sequelize.query<{
        id: string;
        code: string;
        customer_id: string;
        tenant_id: string;
      }>(
        `SELECT id, code, customer_id, tenant_id FROM promo_code.promo_code
             WHERE tenant_id = :tenantId AND correlation_id = :correlationId`,
        { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
      );
      return rows[0] ?? null;
    }, 20_000);

    expect(row.tenant_id).toBe(tenantId);
    expect(row.customer_id).toBe('cust-t-pc-030-tc15');
    expect(row.code.startsWith('KAFKA-')).toBe(true);
  });

  // TC-16
  it('TC-16: a malformed message appears on the DLQ topic after the retry window', async () => {
    const key = `t-pc-030-tc16-${randomUUID()}`;

    await producer.send({
      topic: GENERATE_REQUESTED_TOPIC,
      messages: [{ key, value: '{this is not valid json' }],
    });

    const dlqMessage = await waitForDlqMessage(key, 30_000);

    expect(dlqMessage.raw).toBe('{this is not valid json');
    expect(typeof dlqMessage.error).toBe('string');
    expect(typeof dlqMessage.failedAt).toBe('string');
  });

  // T-PC-047 TC-2 (this task's own numbering): before this task's fix, this same real
  // `GenerateRequestedConsumer.start()` process (backed by `KafkaConsumerModule`, booted here via
  // `Test.createTestingModule` exactly like `KafkaConsumerRootModule` boots it in production) emitted
  // `GenerateRequestedConsumer`'s own log lines as the default `ConsoleLogger`'s human-readable
  // text — `Logger.overrideLogger` was never called anywhere in this module graph, since
  // `KafkaConsumerModule` never imported `LoggingModule` (see that module's own T-PC-047 note).
  // Reproducing that would mean reverting this suite's own `imports` array back to just
  // `[ConfigModule, KafkaConsumerModule]` *without* `kafka-consumer.module.ts`'s `LoggingModule`
  // addition; this test proves the fixed state — one JSON line, correlationId matching this
  // message's own envelope `correlationId`, transport `'KAFKA'`.
  it("T-PC-047 TC-2: a real generate.requested message's structured log line carries its own correlationId (real broker)", async () => {
    const { tenantId, bindRefId } = await seedBoundConfig();
    const correlationId = randomUUID();
    const message = envelope(correlationId, tenantId, {
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-t-pc-047',
      merchantId: null,
      activityContext: null,
    });

    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write);

    function matchingEntries(): Record<string, unknown>[] {
      return written
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .filter((entry) => entry.correlationId === correlationId);
    }

    let entries: Record<string, unknown>[] = [];
    try {
      await producer.send({
        topic: GENERATE_REQUESTED_TOPIC,
        messages: [{ key: correlationId, value: JSON.stringify(message) }],
      });

      // Poll for the log line itself, not just the DB row it's expected to precede — this
      // consumer is a long-running, shared instance (started once in `beforeAll`, already used by
      // every preceding test in this file), so waiting on the log line directly, rather than
      // assuming it is always captured by the time some other side effect (the DB row) is
      // observed, is the more direct and robust proof of TC-2's own claim.
      entries = await pollUntil(async () => {
        const found = matchingEntries();
        return found.length > 0 ? found : null;
      }, 20_000);
    } finally {
      spy.mockRestore();
    }

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.transport).toBe('KAFKA');
      expect(entry.rpc).toBe(GENERATE_REQUESTED_TOPIC);
      expect(typeof entry.level).toBe('string');
      expect(typeof entry.timestamp).toBe('string');
      expect(typeof entry.message).toBe('string');
    }
  });
});
