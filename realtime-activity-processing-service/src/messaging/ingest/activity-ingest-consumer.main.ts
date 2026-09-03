/**
 * T-RAP-023. Standalone composition root for the `activity.ingest.v1` Kafka consumer, run as its
 * own process — **not** wired into `src/main.ts`'s HTTP bootstrap, for the identical file-scope
 * reason `src/grpc/grpc-server.main.ts` (T-RAP-022) already documents in full: `src/main.ts`/
 * `src/app.module.ts` are `agent-rap-foundation`'s own file scope, not this agent's
 * (`realtime-activity-processing-service-plan/project.config.json`). This file ships its own tiny
 * root module (`IngestConsumerRootModule` below, importing only the `@Global` `ConfigModule` and
 * this task's own `IngestModule`) and its own bootstrap function — every test in
 * `test/messaging/ingest/**` that needs a real broker boots this same root module directly, so
 * this file and the test suite exercise identical wiring.
 *
 * `ACTIVITY_INGEST_CONSUMER_ENABLED` (default enabled) is this task's own Rollback lever, same
 * `GRPC_SERVER_ENABLED`/`KAFKA_CONSUMER_ENABLED` convention already established across this repo —
 * set to `"false"` to keep this process from ever opening a broker connection, rather than
 * starting a consumer that has to be torn down separately.
 */
import 'reflect-metadata';
import { Module, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { IngestModule } from './ingest.module';
import { ActivityIngestConsumer } from './activity-ingest.consumer';
import { ACTIVITY_INGEST_CONSUMER_ENABLED_ENV_VAR } from './ingest.config';

@Module({
  imports: [ConfigModule, IngestModule],
})
export class IngestConsumerRootModule {}

const logger = new Logger('ActivityIngestConsumerBootstrap');

function isEnabled(): boolean {
  return process.env[ACTIVITY_INGEST_CONSUMER_ENABLED_ENV_VAR] !== 'false';
}

/**
 * Returns `null` when `ACTIVITY_INGEST_CONSUMER_ENABLED=false` (the Rollback lever, this file's
 * own header) — callers must treat `null` as "do not start this transport", not retry or fall
 * back to any other behaviour. Otherwise returns a constructed (but not yet consuming) app
 * context; callers still need to call `.get(ActivityIngestConsumer).start()`.
 */
export async function createIngestConsumerContext(): Promise<INestApplicationContext | null> {
  if (!isEnabled()) {
    return null;
  }
  return NestFactory.createApplicationContext(IngestConsumerRootModule);
}

export async function bootstrap(): Promise<void> {
  const app = await createIngestConsumerContext();
  if (app === null) {
    logger.warn(
      `${ACTIVITY_INGEST_CONSUMER_ENABLED_ENV_VAR}=false — activity.ingest.v1 consumer not started`,
    );
    return;
  }
  const consumer = app.get(ActivityIngestConsumer);
  await consumer.start();
  logger.log('activity.ingest.v1 consumer listening (shared consumer group)');
}

/* istanbul ignore next -- exercised as a real process by manual/e2e verification against a real
 * Redpanda broker (see `test/messaging/ingest/*.e2e-spec.ts`), not by the automated unit suite. */
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error(
      'activity.ingest.v1 consumer failed to start',
      error instanceof Error ? error.stack : error,
    );
    process.exitCode = 1;
  });
}
