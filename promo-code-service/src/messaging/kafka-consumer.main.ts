/**
 * T-PC-030. Standalone composition root for the `generate.requested` Kafka consumer, run as its
 * own process — **not** wired into `src/main.ts`'s HTTP bootstrap.
 *
 * ### Why a separate entry point instead of a hybrid app in `main.ts`
 *
 * `src/main.ts` and `src/app.module.ts` are both exclusively `agent-promo-foundation`'s file scope
 * (`project.config.json`); this agent's own delegated scope is `src/messaging/**`/`src/grpc/**`/
 * `proto/**`/`test/messaging/**`/`test/grpc/**` — same file-scope discipline
 * `grpc-server.main.ts` (T-PC-031) already established for this exact reason (see that file's own
 * header for the full "why not touch an append-only registration point" argument). This task ships
 * its own tiny root module (`KafkaConsumerRootModule` below) that imports only `ConfigModule`
 * (`@Global`, needed for every `ConfigService` injection in the module tree below it) and this
 * task's own `KafkaConsumerModule`, plus its own `NestFactory.createApplicationContext(...)`
 * bootstrap (an application context, not an HTTP/gRPC listener — this process's only job is to run
 * `GenerateRequestedConsumer.start()`'s background kafkajs loop, not answer a request).
 *
 * **Follow-up flagged for the architect/reviewer** (this task's own completion report): running
 * this as a second OS process alongside `main.ts`'s HTTP process and `grpc-server.main.ts`'s gRPC
 * process is a legitimate, working deployment shape (`ARCHITECTURE.md` never mandates one
 * process), but folding all three into a single hybrid process via `main.ts` — if that is the
 * preferred production topology — is a follow-up for `agent-promo-foundation`, since it requires
 * editing files outside this task's scope (same follow-up `grpc-server.main.ts` already flagged).
 *
 * ### Rollback
 *
 * `KAFKA_CONSUMER_ENABLED=false` skips `start()` entirely and this process logs and returns
 * without ever connecting to a broker, rather than starting a listener that has to be torn down
 * separately (this task file's own "Rollback" section).
 *
 * ### T-PC-048 — this process's own `GET /metrics`
 *
 * Before this change this process bootstrapped via `NestFactory.createApplicationContext(...)` —
 * no HTTP (or any) listener at all, deliberately, since its only job was running
 * `GenerateRequestedConsumer.start()`'s background `kafkajs` loop. That meant even after
 * `kafka-consumer.module.ts`'s own T-PC-048 fix (`KafkaConsumerModule` importing `MetricsModule`,
 * which wraps *this* process's own live `PromoCodeGenerationService` instance and increments its
 * own in-memory `codes_generated_total`/`promo_code_generation_duration_seconds`), nothing could
 * ever scrape it — a Prometheus target aimed at the HTTP `AppModule` process reads a completely
 * different process's own separate in-memory registry, which never saw a Kafka-originated
 * generation at all. `createKafkaConsumerApp()` below builds a full, HTTP-capable
 * `NestFactory.create(...)` application instead of an application-context-only one — the same DI
 * graph as before (an application context is a strict subset of what a full application provides;
 * every `app.get(...)` call below behaves identically), plus a real Express HTTP adapter this
 * process's own `MetricsController` (imported transitively via `MetricsModule`) can now actually
 * bind `GET /metrics` to. Exported (not just inlined into `bootstrap()`) specifically so
 * `test/messaging/kafka-consumer-metrics.e2e-spec.ts` boots the exact same wiring a real
 * deployment does, rather than a parallel, potentially-drifting test-only setup.
 */
import 'reflect-metadata';
import { Module, Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '../config/config.module';
import { KafkaConsumerModule } from './kafka-consumer.module';
import { GenerateRequestedConsumer } from './generate-requested.consumer';
import {
  GENERATE_REQUESTED_CONSUMER_GROUP,
  KAFKA_CONSUMER_ENABLED_ENV_VAR,
  isKafkaMetricsListenerEnabled,
  parseKafkaMetricsPort,
} from './kafka-consumer.config';

@Module({
  imports: [ConfigModule, KafkaConsumerModule],
})
export class KafkaConsumerRootModule {}

const logger = new Logger('KafkaConsumerBootstrap');

/** Same DI graph `createApplicationContext(KafkaConsumerRootModule)` built before this task —
 * just via the full, HTTP-capable `NestFactory.create(...)` instead, so this process's own
 * `GET /metrics` (T-PC-048) has an Express adapter to bind to. Not yet listening for HTTP; the
 * caller decides (`app.listen(port)` vs. `app.init()` alone) — mirrors `GRPC_METRICS_ENABLED`'s
 * own on/off lever in `grpc-server.main.ts`. */
export async function createKafkaConsumerApp(): Promise<INestApplication> {
  return NestFactory.create(KafkaConsumerRootModule);
}

export async function bootstrap(): Promise<void> {
  if (process.env[KAFKA_CONSUMER_ENABLED_ENV_VAR] === 'false') {
    logger.warn(`${KAFKA_CONSUMER_ENABLED_ENV_VAR}=false — Kafka consumer not started`);
    return;
  }

  const app = await createKafkaConsumerApp();
  const consumer = app.get(GenerateRequestedConsumer);

  if (isKafkaMetricsListenerEnabled()) {
    const metricsPort = parseKafkaMetricsPort();
    await app.listen(metricsPort);
    logger.log(
      `Kafka consumer process metrics listening — GET http://0.0.0.0:${metricsPort}/metrics`,
    );
  } else {
    await app.init();
    logger.warn("KAFKA_METRICS_ENABLED=false — this process's own GET /metrics not started");
  }

  await consumer.start();
  logger.log(
    `Kafka consumer listening on "generate.requested" (group "${GENERATE_REQUESTED_CONSUMER_GROUP}")`,
  );
}

/* istanbul ignore next -- exercised as a real process against a real broker, not by the automated
 * suite (which drives `GenerateRequestedConsumer.processMessage()` directly, or boots
 * `KafkaConsumerRootModule` via `Test.createTestingModule` for a real-Redpanda e2e round trip —
 * see `test/messaging/generate-requested.consumer.e2e-spec.ts`). */
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error('Kafka consumer failed to start', error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
