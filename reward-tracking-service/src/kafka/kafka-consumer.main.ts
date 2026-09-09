/**
 * T-RTS-012. Standalone composition root for the `reward.redemption.completed.v1` Kafka consumer,
 * run as its own process — **not** wired into `src/main.ts`'s HTTP bootstrap, for the identical
 * file-scope reason `src/grpc/grpc-server.main.ts` (T-RTS-011) already documents in full:
 * `src/main.ts`/`src/app.module.ts` are both exclusively `agent-rts-foundation`'s file scope.
 * Mirrors `reward-redemption-service`'s own `src/messaging/ingest/kafka-consumer.main.ts`
 * (T-RR-012, confirmed by direct read) shape exactly, including its `KAFKA_CONSUMER_ENABLED`
 * rollback lever.
 *
 * Not added to this task's own literal "Files owned" list in the task file, but squarely inside
 * this agent's delegated `src/kafka/**` scope grant and necessary to produce a real,
 * Redpanda-connectable running instance for this task's own verification step 2 — same "extra
 * file added when the implementation genuinely needs it, inside this agent's own scope grant"
 * precedent `T-RTS-011`'s own `grpc-server.main.ts` already established — flagged explicitly in
 * this task's completion report.
 *
 * **Calls `loadDotenvFilesIntoProcessEnv()` as its very first statement**, same reasoning
 * `grpc-server.main.ts`'s own header gives: a real, separately-spawned process reads `undefined`
 * for every dotenv-only var a later module pulls straight off `process.env` unless this runs
 * before `ConfigModule`/`KafkaModule` are ever imported.
 */
import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from '@/config/load-dotenv-files';

// Deliberately before the `ConfigModule`/`KafkaModule` imports below — see this file's own header.
loadDotenvFilesIntoProcessEnv();

import { Module, Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@/config/config.module';
import { KafkaModule } from './kafka.module';
import { RewardTrackingConsumerService } from './reward-tracking-consumer.service';

export const KAFKA_CONSUMER_ENABLED_ENV_VAR = 'KAFKA_CONSUMER_ENABLED';

@Module({
  imports: [ConfigModule, KafkaModule],
})
class KafkaConsumerRootModule {}

const logger = new Logger('RewardTrackingKafkaConsumerBootstrap');

function isEnabled(): boolean {
  return process.env[KAFKA_CONSUMER_ENABLED_ENV_VAR] !== 'false';
}

/**
 * Returns `null` when `KAFKA_CONSUMER_ENABLED=false` — callers must treat `null` as "do not start
 * this transport", not retry or fall back to any other behaviour. Otherwise returns a constructed
 * (but not yet consuming) app context; callers still need to call
 * `.get(RewardTrackingConsumerService).start()`.
 */
export async function createKafkaConsumerContext(): Promise<INestApplicationContext | null> {
  if (!isEnabled()) {
    return null;
  }
  return NestFactory.createApplicationContext(KafkaConsumerRootModule);
}

export async function bootstrap(): Promise<void> {
  const app = await createKafkaConsumerContext();
  if (app === null) {
    logger.warn(
      `${KAFKA_CONSUMER_ENABLED_ENV_VAR}=false — reward.redemption.completed.v1 consumer not started`,
    );
    return;
  }
  const consumer = app.get(RewardTrackingConsumerService);
  await consumer.start();
  logger.log('reward.redemption.completed.v1 consumer listening (shared consumer group)');
}

/* istanbul ignore next -- exercised as a real process by manual verification against a real
 * Redpanda broker (this task's own verification step 2), not by the automated unit suite (which
 * boots `KafkaConsumerRootModule` directly via `NestFactory.createApplicationContext` for a
 * faster, in-process real-Postgres run — see `test/kafka/reward-tracking-consumer.service.spec.ts`). */
if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    logger.error(
      'reward.redemption.completed.v1 consumer failed to start',
      error instanceof Error ? error.stack : String(error),
    );
    process.exitCode = 1;
  });
}
