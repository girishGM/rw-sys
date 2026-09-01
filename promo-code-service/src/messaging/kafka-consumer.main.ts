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
 */
import 'reflect-metadata';
import { Module, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '../config/config.module';
import { KafkaConsumerModule } from './kafka-consumer.module';
import { GenerateRequestedConsumer } from './generate-requested.consumer';
import {
  GENERATE_REQUESTED_CONSUMER_GROUP,
  KAFKA_CONSUMER_ENABLED_ENV_VAR,
} from './kafka-consumer.config';

@Module({
  imports: [ConfigModule, KafkaConsumerModule],
})
export class KafkaConsumerRootModule {}

const logger = new Logger('KafkaConsumerBootstrap');

export async function bootstrap(): Promise<void> {
  if (process.env[KAFKA_CONSUMER_ENABLED_ENV_VAR] === 'false') {
    logger.warn(`${KAFKA_CONSUMER_ENABLED_ENV_VAR}=false — Kafka consumer not started`);
    return;
  }

  const app = await NestFactory.createApplicationContext(KafkaConsumerRootModule);
  const consumer = app.get(GenerateRequestedConsumer);
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
