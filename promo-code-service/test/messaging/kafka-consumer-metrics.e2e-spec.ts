/**
 * T-PC-048. Real round trip proving the fix for the defect T-PC-042 reported and could not close
 * itself (R8): before this task, `KafkaConsumerRootModule` bootstrapped via
 * `NestFactory.createApplicationContext(...)` — no HTTP (or any) listener at all — and its own
 * `PromoCodeGenerationService` instance was never wrapped by `GenerationLatencyInstrumentation`
 * (`KafkaConsumerModule` never imported `MetricsModule`), so
 * `codes_generated_total`/`promo_code_generation_duration_seconds` never moved for the real Kafka
 * generation path this process alone actually serves in production
 * (`kafka-consumer.module.ts`'s/`kafka-consumer.main.ts`'s own T-PC-048 notes explain both halves
 * of the fix in full).
 *
 * Boots `createKafkaConsumerApp()` directly — the exact exported building block
 * `kafka-consumer.main.ts`'s own real `bootstrap()` calls — against a real Redpanda broker
 * (`docker-compose.yml`'s `redpanda` service, T-PC-001) and the real, already-migrated
 * `promo_code` schema (root `CLAUDE.md`) — same "assert the observable property, not the
 * implementation string" discipline `generate-requested.consumer.e2e-spec.ts` (T-PC-030) already
 * established (`AGENT-PROTOCOL.md` §3): only a real scrape of a real, listening process can
 * actually prove this.
 *
 * **Requires a running Redpanda** (`docker compose up -d redpanda` from `promo-code-service/`,
 * `KAFKA_BROKERS=localhost:9092`) — this suite is real infrastructure, not mocked, by design, same
 * requirement `generate-requested.consumer.e2e-spec.ts` already documents.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import request from 'supertest';
import { createKafkaConsumerApp } from '@/messaging/kafka-consumer.main';
import { GenerateRequestedConsumer } from '@/messaging/generate-requested.consumer';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import { GENERATE_REQUESTED_TOPIC } from '@/messaging/kafka-consumer.config';
import { createAppTestConnection } from '../config/support/app-connection';

jest.setTimeout(60_000);

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('failed to allocate a free port'));
      }
    });
  });
}

async function pollUntil<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`pollUntil: timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** `promo_code_codes_generated_total{transport="KAFKA",outcome="SUCCESS"} N` — 0 if absent. */
function parseCodesGeneratedTotal(text: string): number {
  const match = text.match(
    /promo_code_codes_generated_total\{transport="KAFKA",outcome="SUCCESS"\} (\d+)/,
  );
  return match ? Number(match[1]) : 0;
}

describe('T-PC-048 — Kafka consumer process own GET /metrics (real Redpanda, real Postgres) (e2e)', () => {
  let app: INestApplication;
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
    const metricsPort = await getFreePort();
    process.env.KAFKA_METRICS_PORT = String(metricsPort);
    delete process.env.KAFKA_CONSUMER_ENABLED;
    delete process.env.KAFKA_METRICS_ENABLED;

    app = await createKafkaConsumerApp();
    consumer = app.get(GenerateRequestedConsumer);
    promoCodeConfigRepository = app.get(PromoCodeConfigRepository);
    bindingService = app.get(CampaignBindingService);

    await app.listen(metricsPort);
    await consumer.start();

    sequelize = createAppTestConnection();
    await sequelize.authenticate();

    const kafka = new Kafka({
      clientId: 't-pc-048-e2e-producer',
      brokers,
      logLevel: logLevel.NOTHING,
    });
    producer = kafka.producer();
    await producer.connect();
  });

  afterAll(async () => {
    await producer.disconnect();
    await consumer.stop();
    await app.close();
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
      name: `t-pc-048 e2e config ${randomUUID()}`,
      codePrefix: 'MET-K-',
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

  // TC-2/TC-3 (this task's own numbering): reverting either `kafka-consumer.module.ts`'s
  // `MetricsModule` import or `kafka-consumer.main.ts`'s HTTP-capable-app bootstrap reproduces
  // TC-1 (the reported symptom) — this same GET /metrics scrape would then either never see the
  // counter move (module not imported) or fail to connect at all (no HTTP listener, since
  // `createApplicationContext` never starts one). Proven by reverting each change locally and
  // re-running this file: both reproduce a red test (see completion report).
  it("T-PC-048 TC-2: a real generate.requested message increments this process's own codes_generated_total, scrapable via this same process's real GET /metrics", async () => {
    const before = await request(app.getHttpServer()).get('/metrics');
    expect(before.status).toBe(200);
    expect(before.headers['content-type']).toContain('text/plain');
    const beforeCount = parseCodesGeneratedTotal(before.text);

    const { tenantId, bindRefId } = await seedBoundConfig();
    const correlationId = randomUUID();
    const message = envelope(correlationId, tenantId, {
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-t-pc-048-kafka',
      merchantId: null,
      activityContext: null,
    });

    await producer.send({
      topic: GENERATE_REQUESTED_TOPIC,
      messages: [{ key: correlationId, value: JSON.stringify(message) }],
    });

    await pollUntil(async () => {
      const rows = await sequelize.query(
        `SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId`,
        { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
      );
      return rows.length > 0 ? true : null;
    }, 20_000);

    const after = await pollUntil(async () => {
      const scrape = await request(app.getHttpServer()).get('/metrics');
      const count = parseCodesGeneratedTotal(scrape.text);
      return count > beforeCount ? scrape.text : null;
    }, 10_000);

    expect(parseCodesGeneratedTotal(after)).toBe(beforeCount + 1);
    expect(after).toMatch(/promo_code_generation_duration_seconds_count\{transport="KAFKA"\} \d+/);
  });
});
