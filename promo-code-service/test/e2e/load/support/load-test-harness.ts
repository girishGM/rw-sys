/**
 * T-PC-043. Shared harness for `test/e2e/load/**` — boots the same three real,
 * independently-deployable composition roots `test/e2e/setup/e2e-test-app.ts` (T-PC-040) already
 * established (HTTP `AppModule`, mTLS gRPC `GrpcMicroserviceRootModule`, Kafka
 * `KafkaConsumerRootModule`), against the same real, already-migrated `promo_code` schema (root
 * `CLAUDE.md`) and the same real Redpanda broker (`docker-compose.yml`, T-PC-001) — deliberately
 * **not** a fourth, load-test-specific composition root, for the same reason that file gives:
 * production never runs a hybrid shape either.
 *
 * Two differences from `E2ETestHarness`, both load-test-specific:
 *
 * 1. **The gRPC and Kafka processes are booted via their own real standalone bootstrap building
 *    blocks** (`createGrpcHybridApp()`/`createKafkaConsumerApp()`, `grpc-server.main.ts`/
 *    `kafka-consumer.main.ts`, T-PC-031/T-PC-030/T-PC-048) rather than the plain
 *    `NestFactory.createMicroservice`/`Test.createTestingModule` shape T-PC-040's own harness
 *    uses — specifically so each process's own real `GET /metrics` HTTP surface is reachable here,
 *    the same "same numbers an operator would see in production" discipline this task's own
 *    implementation note 3 requires (`AGENT-PROTOCOL.md` §3: "assert the observable property, not
 *    the implementation string" — a load test that read `MetricsService.render()` in-process
 *    instead of scraping the real HTTP surface would not actually prove the metric is *reachable*
 *    under load, only that the counter moved somewhere in memory).
 * 2. **`OUTBOX_PUBLISHER_AUTOSTART=true` is forced** here, overriding the `NODE_ENV=test` default
 *    every other `*.e2e-spec.ts` in this project relies on to avoid racing a live poller
 *    (`outbox-publisher.config.ts`'s own header) — this suite's entire purpose is to observe that
 *    real poll-interval/batch-size behaviour under sustained load, not to avoid it. Because this
 *    harness is the only thing running against this schema while a load spec executes (Jest runs
 *    each `*.e2e-spec.ts` file in its own worker/process; nothing else in `test/e2e/load/**` shares
 *    a Jest worker with another suite's own unscoped outbox rows), the "don't race a live poller
 *    against a concurrently-running suite's own rows" hazard T-PC-045 fixed for the *shared*
 *    harness does not apply to this dedicated one.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as grpc from '@grpc/grpc-js';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';

import request from 'supertest';

import { AppModule } from '@/app.module';
import { createGrpcHybridApp } from '@/grpc/grpc-server.main';
import { createKafkaConsumerApp } from '@/messaging/kafka-consumer.main';
import { GenerateRequestedConsumer } from '@/messaging/generate-requested.consumer';
import { GENERATE_REQUESTED_TOPIC } from '@/messaging/kafka-consumer.config';
import { GENERATE_RESULT_TOPIC } from '@/modules/generation/promo-code-generation.constants';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';

import {
  TestCertAuthority,
  type IssuedCertificate,
} from '../../../grpc/support/test-cert-authority';
import {
  createTestClient,
  callGenerateCode,
  type PromoCodeServiceTestClient,
} from '../../../grpc/support/test-grpc-client';
import { createAppTestConnection } from '../../../config/support/app-connection';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getFreePort(): Promise<number> {
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
        reject(new Error('getFreePort: failed to allocate a free port'));
      }
    });
  });
}

/** Polls `fn` until it returns `true`, or throws once `timeoutMs` elapses. */
export async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: condition not met after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

export interface LatencyStats {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

/** Real observed latency percentiles from this run's own measurements — never a synthetic or
 * assumed distribution (`AGENT-PROTOCOL.md` §3). */
export function summarizeLatencies(latenciesMs: number[]): LatencyStats {
  if (latenciesMs.length === 0) {
    return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    avgMs: sum / sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1],
  };
}

/**
 * Fires `task(i)` `totalCount` times, spaced so the *scheduling* rate (not the completion rate)
 * averages `ratePerSec` — the "controlled rate" the task file's own Objective asks for. Each
 * `task(i)` call is never awaited before scheduling the next one (a real caller issuing sustained
 * load does not serialize on one request's completion before sending the next), but every one of
 * them is collected and awaited together before this function returns, so a caller always sees
 * every attempt's outcome.
 */
export async function runAtRate(
  totalCount: number,
  ratePerSec: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  const intervalMs = 1000 / ratePerSec;
  const inFlight: Promise<void>[] = [];
  for (let i = 0; i < totalCount; i += 1) {
    const tickStartedAt = Date.now();
    inFlight.push(task(i));
    const elapsed = Date.now() - tickStartedAt;
    const remaining = intervalMs - elapsed;
    if (remaining > 0) {
      await sleep(remaining);
    }
  }
  await Promise.all(inFlight);
}

/** Extracts the numeric value following an exact Prometheus text-exposition-format metric+label
 * string (e.g. `promo_code_codes_generated_total{transport="KAFKA",outcome="SUCCESS"}`) — `0` if
 * the line is absent (no observation yet for that label combination), same convention
 * `test/grpc/grpc-server-metrics.e2e-spec.ts`/`test/messaging/kafka-consumer-metrics.e2e-spec.ts`
 * (T-PC-048) already established, generalised here so every load spec shares one implementation. */
export function parseMetricValue(metricsText: string, nameWithLabels: string): number {
  const escaped = nameWithLabels.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = metricsText.match(new RegExp(`${escaped} ([0-9.]+)`));
  return match ? Number(match[1]) : 0;
}

export interface BoundLoadConfigFixture {
  tenantId: string;
  actorId: string;
  configId: string;
  bindRefId: string;
}

/**
 * Boots the three real composition roots plus a real mTLS CA/allowlisted client identity and a
 * real Kafka producer. `LoadTestHarness.create()` forces `OUTBOX_PUBLISHER_AUTOSTART=true` (see
 * this file's own header) — every `*.e2e-spec.ts` under `test/e2e/load/**` therefore observes the
 * same outbox poll-interval/batch-size behaviour a real deployment would, not a manually-pumped
 * test-only substitute.
 */
export class LoadTestHarness {
  private constructor(
    readonly httpApp: INestApplication,
    readonly grpcApp: INestApplication,
    readonly grpcAddress: string,
    readonly kafkaApp: INestApplication,
    readonly kafkaConsumer: GenerateRequestedConsumer,
    readonly sequelize: Sequelize,
    private readonly promoCodeConfigRepository: PromoCodeConfigRepository,
    private readonly bindingService: CampaignBindingService,
    readonly producer: Producer,
    private readonly ca: TestCertAuthority,
    private readonly allowedCert: IssuedCertificate,
    private readonly serviceIdentityIds: string[],
    private readonly tenantIds: string[],
  ) {}

  static async create(): Promise<LoadTestHarness> {
    const ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    const grpcMetricsPort = await getFreePort();
    const kafkaMetricsPort = await getFreePort();

    process.env.GRPC_PORT = String(grpcPort);
    process.env.GRPC_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_METRICS_PORT = String(grpcMetricsPort);
    delete process.env.GRPC_SERVER_ENABLED;
    delete process.env.GRPC_METRICS_ENABLED;

    process.env.KAFKA_METRICS_PORT = String(kafkaMetricsPort);
    delete process.env.KAFKA_CONSUMER_ENABLED;
    delete process.env.KAFKA_METRICS_ENABLED;

    // This file's own header, point 2: real production outbox-publishing behaviour under load,
    // not the `NODE_ENV=test` default every other shared-harness suite relies on.
    process.env.OUTBOX_PUBLISHER_AUTOSTART = 'true';

    const httpModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const httpApp = httpModuleRef.createNestApplication();
    await httpApp.init();

    const grpcCreated = await createGrpcHybridApp();
    if (grpcCreated === null) {
      throw new Error('LoadTestHarness: expected createGrpcHybridApp() to return an app');
    }
    const grpcApp = grpcCreated.app;
    await grpcApp.startAllMicroservices();
    await grpcApp.listen(grpcMetricsPort);
    const grpcAddress = `localhost:${grpcPort}`;

    const kafkaApp = await createKafkaConsumerApp();
    const kafkaConsumer = kafkaApp.get(GenerateRequestedConsumer);
    await kafkaApp.listen(kafkaMetricsPort);
    await kafkaConsumer.start();

    const sequelize = createAppTestConnection();
    await sequelize.authenticate();

    const promoCodeConfigRepository = httpApp.get(PromoCodeConfigRepository);
    const bindingService = httpApp.get(CampaignBindingService);

    // Short, fresh-per-run identity (X.509 CN is capped at 64 bytes — same constraint
    // `test/e2e/setup/e2e-test-app.ts`'s own header documents).
    const allowedIdentity = `t-pc-043-load-${randomUUID()}`;
    const allowedCert = ca.issueClientCert(allowedIdentity);
    const [identityRow] = await sequelize.query<{ id: string }>(
      `INSERT INTO promo_code.grpc_service_identity (service_identity, description, created_by)
         VALUES (:identity, 'T-PC-043 load harness', :actor) RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { identity: allowedIdentity, actor: randomUUID() },
      },
    );

    const brokers = String(process.env.KAFKA_BROKERS ?? 'localhost:9092')
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
    const kafka = new Kafka({
      clientId: 't-pc-043-load-producer',
      brokers,
      logLevel: logLevel.NOTHING,
    });
    const producer = kafka.producer();
    await producer.connect();

    return new LoadTestHarness(
      httpApp,
      grpcApp,
      grpcAddress,
      kafkaApp,
      kafkaConsumer,
      sequelize,
      promoCodeConfigRepository,
      bindingService,
      producer,
      ca,
      allowedCert,
      [identityRow.id],
      [],
    );
  }

  freshTenant(): string {
    const tenantId = randomUUID();
    this.tenantIds.push(tenantId);
    return tenantId;
  }

  /** Provisions a tenant + `ACTIVE` config + `CAMPAIGN`-level binding directly through the real
   * domain services (`PromoCodeConfigRepository`/`CampaignBindingService`) rather than an HTTP
   * round trip — a load test's own fixture setup should not itself be rate-limited by the HTTP
   * stack under test; the write paths exercised are the identical ones the REST controllers call
   * (`04-API-CONTRACT.md` §2/§3), so nothing about the resulting row differs from a real bind. */
  async seedBoundConfig(codePrefix: string): Promise<BoundLoadConfigFixture> {
    const tenantId = this.freshTenant();
    const actorId = randomUUID();
    const config = await this.promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-043 load config ${randomUUID()}`,
      codePrefix,
      codePostfix: null,
      codeLength: 12,
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
    await this.bindingService.bind({
      promoCodeConfigId: config.id,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      boundBy: actorId,
    });
    return { tenantId, actorId, configId: config.id, bindRefId };
  }

  allowedGrpcClient(): PromoCodeServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(this.ca.caCertPath),
      readFileSync(this.allowedCert.keyPath),
      readFileSync(this.allowedCert.certPath),
    );
    return createTestClient(this.grpcAddress, credentials);
  }

  /** No client key/cert pair presented at all — only the CA, to verify the server certificate.
   * Same shape `test/e2e/setup/e2e-test-app.ts`'s own `noCertGrpcClient()` (T-PC-040) already
   * established, used here to prove sustained load on the allowed identity never weakens the
   * mTLS guard for a different, unauthenticated caller. */
  noCertGrpcClient(): PromoCodeServiceTestClient {
    const credentials = grpc.credentials.createSsl(readFileSync(this.ca.caCertPath));
    return createTestClient(this.grpcAddress, credentials);
  }

  async publishGenerateRequested(
    correlationId: string,
    tenantId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const envelope = {
      eventId: randomUUID(),
      eventType: 'promo-code.generate.requested',
      eventVersion: '1.0',
      occurredAt: new Date().toISOString(),
      correlationId,
      tenantId,
      source: 'reward-redemption-service',
      data,
    };
    await this.producer.send({
      topic: GENERATE_REQUESTED_TOPIC,
      messages: [{ key: correlationId, value: JSON.stringify(envelope) }],
    });
  }

  async teardown(): Promise<void> {
    for (const tenantId of this.tenantIds) {
      await this.sequelize.query(
        `DELETE FROM promo_code.promo_code_outbox
           WHERE promo_code_id IN (SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId)`,
        { replacements: { tenantId } },
      );
      await this.sequelize.query('DELETE FROM promo_code.promo_code WHERE tenant_id = :tenantId', {
        replacements: { tenantId },
      });
      await this.sequelize.query(
        'DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
      await this.sequelize.query(
        'DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
    }
    if (this.serviceIdentityIds.length > 0) {
      await this.sequelize.query(
        'DELETE FROM promo_code.grpc_service_identity WHERE id IN (:ids)',
        {
          type: QueryTypes.RAW,
          replacements: { ids: this.serviceIdentityIds },
        },
      );
    }

    await this.producer.disconnect();
    await this.kafkaConsumer.stop();
    await this.kafkaApp.close();
    await this.grpcApp.close();
    await this.sequelize.close();
    await this.httpApp.close();
    this.ca.cleanup();
  }
}

const KAFKA_BROKERS: string[] = String(process.env.KAFKA_BROKERS ?? 'localhost:9092')
  .split(',')
  .map((broker) => broker.trim())
  .filter(Boolean);

export function generateActivityData(
  customerId: string,
  bindRefId: string,
): Record<string, unknown> {
  return {
    bindLevel: 'CAMPAIGN',
    bindRefId,
    customerId,
    merchantId: null,
    activityContext: { amount: '25.00', currency: 'USD', metadata: {} },
  };
}

export interface KafkaStepResult {
  label: string;
  targetRatePerSec: number;
  attempted: number;
  succeeded: number;
  failedBusiness: number;
  unresolved: number;
  latency: LatencyStats;
  /** `countTenantOutboxPending`'s own header — scoped to this step's own `tenantId`, not the
   * global `/metrics` gauge (`kafka-load.e2e-spec.ts`'s own TC-4 exercises that one separately). */
  outboxPendingAtStepStart: number;
  outboxPendingAtStepEnd: number;
  outboxPendingAfterDrain: number;
}

/** `promo_code_outbox_pending_count` — the outbox backlog gauge, scraped from the real HTTP
 * `AppModule` process's own `GET /metrics` (that is the process running the real
 * `OutboxPublisherWorker`, `src/app.module.ts`) — this task's own implementation note 3: "the
 * load test's own instrumentation, not a separate ad hoc measurement path". Deliberately a
 * *global*, unscoped count — the same real production semantics an operator's own dashboard
 * would read (`metrics.service.ts`'s own `refreshOutboxBacklog`, no `tenant_id` filter) — used by
 * `kafka-load.e2e-spec.ts`'s own TC-4 to prove the metric itself is reachable and moves under
 * load, never as a per-step pass/fail bound (see `countTenantOutboxPending` below for that). */
export async function scrapeOutboxPending(harness: LoadTestHarness): Promise<number> {
  const response = await request(harness.httpApp.getHttpServer()).get('/metrics');
  if (response.status !== 200) {
    throw new Error(`scrapeOutboxPending: GET /metrics returned ${response.status}`);
  }
  return parseMetricValue(response.text, 'promo_code_outbox_pending_count');
}

/**
 * `PENDING` row count scoped to `tenantId` — the correct tool for "did *this step's own* backlog
 * drain", unlike the global `/metrics` gauge above. This project's own full, parallel `npm test`
 * has every other `*.e2e-spec.ts` inserting real rows into this same shared `promo_code_outbox`
 * table at the same time (confirmed directly: the global-gauge version of this assertion failed
 * under full `npm test` with the gauge reading rows this step never created, even after trying a
 * delta-off-a-snapshot approach — the "other suites' own noise" component keeps growing across
 * this step's own multi-second window, not just at its start). `AGENT-PROTOCOL.md` R2's own
 * "every query is scoped by tenant_id at the repository layer" discipline, applied here to this
 * suite's own verification query, not just application code.
 */
export async function countTenantOutboxPending(
  harness: LoadTestHarness,
  tenantId: string,
): Promise<number> {
  const rows = await harness.sequelize.query<{ pending_count: string }>(
    `SELECT COUNT(*) AS pending_count
       FROM promo_code.promo_code_outbox o
       JOIN promo_code.promo_code p ON p.id = o.promo_code_id
      WHERE p.tenant_id = :tenantId AND o.status = 'PENDING'`,
    { type: QueryTypes.SELECT, replacements: { tenantId } },
  );
  return Number(rows[0]?.pending_count ?? 0);
}

/**
 * Publishes `promo-code.generate.requested.v1` at `ratePerSec` for `durationSec`, using a
 * dedicated, fresh consumer group per call to observe only this step's own results on
 * `promo-code.generate.result.v1` — shared by `kafka-load.e2e-spec.ts` (run alone) and
 * `concurrent-load.e2e-spec.ts` (run alongside a simultaneous gRPC step), so both suites measure
 * the Kafka path identically.
 */
export async function runKafkaLoadStep(
  harness: LoadTestHarness,
  label: string,
  ratePerSec: number,
  durationSec: number,
): Promise<KafkaStepResult> {
  // `code_prefix` is `varchar(10)` (`01-DATABASE.md` §1) — a fixed, short literal here, never
  // the (unbounded-length) `label`, so this helper stays safe for any caller-supplied label
  // (`kafka-load.e2e-spec.ts`'s own short labels happened to fit; `concurrent-load.e2e-spec.ts`'s
  // longer ones did not — this was caught directly by a real `SequelizeDatabaseError` running this
  // suite, not by inspection). `label` is still fully traceable via `customerId`/this step's own
  // returned `label` field.
  const { tenantId, bindRefId } = await harness.seedBoundConfig('KL-');
  const totalCount = Math.round(ratePerSec * durationSec);

  // Scoped to this step's own `tenantId` (`countTenantOutboxPending`'s own header) — not the
  // global `/metrics` gauge, which this step does not have exclusive access to under this
  // project's own full, parallel `npm test`.
  const outboxPendingAtStepStart = await countTenantOutboxPending(harness, tenantId);

  const publishedAt = new Map<string, number>();
  const latencies: number[] = [];
  let succeeded = 0;
  let failedBusiness = 0;

  const kafka = new Kafka({
    clientId: `t-pc-043-kafka-load-reader-${randomUUID()}`,
    brokers: KAFKA_BROKERS,
    logLevel: logLevel.NOTHING,
  });
  const consumer: Consumer = kafka.consumer({ groupId: `t-pc-043-kafka-load-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: GENERATE_RESULT_TOPIC, fromBeginning: false });
  const runPromise = consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value || !message.key) {
        return;
      }
      const correlationId = message.key.toString();
      const startedAt = publishedAt.get(correlationId);
      if (startedAt === undefined) {
        return;
      }
      latencies.push(Date.now() - startedAt);
      publishedAt.delete(correlationId);
      const value = JSON.parse(message.value.toString()) as { data?: { status?: string } };
      if (value.data?.status === 'SUCCESS') {
        succeeded += 1;
      } else {
        failedBusiness += 1;
      }
    },
  });

  await runAtRate(totalCount, ratePerSec, async (i) => {
    const correlationId = randomUUID();
    publishedAt.set(correlationId, Date.now());
    await harness.publishGenerateRequested(
      correlationId,
      tenantId,
      generateActivityData(`cust-${label}-${i}`, bindRefId),
    );
  });

  const outboxPendingAtStepEnd = await countTenantOutboxPending(harness, tenantId);

  const tailBudgetMs = Math.max(20_000, totalCount * 200);
  try {
    await waitUntil(() => publishedAt.size === 0, tailBudgetMs, 250);
  } catch {
    // Reported as `unresolved` below rather than thrown — an honest finding for an
    // intentionally-over-capacity step, not a harness bug.
  }

  const outboxPendingAfterDrain = await countTenantOutboxPending(harness, tenantId);

  await consumer.stop();
  await consumer.disconnect();
  await runPromise.catch(() => undefined);

  return {
    label,
    targetRatePerSec: ratePerSec,
    attempted: totalCount,
    succeeded,
    failedBusiness,
    unresolved: publishedAt.size,
    latency: summarizeLatencies(latencies),
    outboxPendingAtStepStart,
    outboxPendingAtStepEnd,
    outboxPendingAfterDrain,
  };
}

export interface GrpcStepResult {
  label: string;
  targetRatePerSec: number;
  attempted: number;
  succeeded: number;
  failedBusiness: number;
  transportErrors: number;
  latency: LatencyStats;
}

/**
 * Calls `GenerateCode` at `ratePerSec` for `durationSec` over an already-open mTLS client —
 * shared by `grpc-load.e2e-spec.ts` (run alone) and `concurrent-load.e2e-spec.ts` (run alongside
 * a simultaneous Kafka step).
 */
export async function runGrpcLoadStep(
  client: PromoCodeServiceTestClient,
  tenantId: string,
  bindRefId: string,
  label: string,
  ratePerSec: number,
  durationSec: number,
): Promise<GrpcStepResult> {
  const totalCount = Math.round(ratePerSec * durationSec);
  const latencies: number[] = [];
  let succeeded = 0;
  let failedBusiness = 0;
  let transportErrors = 0;

  await runAtRate(totalCount, ratePerSec, async (i) => {
    const startedAt = Date.now();
    try {
      const response = await callGenerateCode(client, {
        correlationId: randomUUID(),
        tenantId,
        bindLevel: 'CAMPAIGN',
        bindRefId,
        customerId: `cust-${label}-${i}`,
        merchantId: '',
      });
      latencies.push(Date.now() - startedAt);
      if (response.status === 'SUCCESS') {
        succeeded += 1;
      } else {
        failedBusiness += 1;
      }
    } catch {
      transportErrors += 1;
    }
  });

  return {
    label,
    targetRatePerSec: ratePerSec,
    attempted: totalCount,
    succeeded,
    failedBusiness,
    transportErrors,
    latency: summarizeLatencies(latencies),
  };
}
