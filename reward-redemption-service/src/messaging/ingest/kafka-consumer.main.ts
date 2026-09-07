/**
 * T-RR-012. Standalone composition root for the `reward.entry.created.v1` Kafka consumer, run as
 * its own process — **not** wired into `src/main.ts`'s HTTP bootstrap, for the identical
 * file-scope reason `src/grpc/grpc-server.main.ts` (T-RR-011) already documents in full:
 * `src/main.ts`/`src/app.module.ts` are exclusively `agent-rr-foundation`'s file scope
 * (`reward-redemption-service-plan/project.config.json`); this agent's own delegated scope is
 * `src/grpc/**`/`src/messaging/ingest/**`/`src/rest/reward-entries/**`/
 * `src/modules/reward-ingestion/**`. No separate `ingest.module.ts` exists in this task's own
 * "Files owned" list, so — the same pattern `grpc-server.main.ts` already set with its own inline
 * `GrpcMicroserviceRootModule` — this file declares its own tiny root module inline, importing only
 * the `@Global` `ConfigModule` and `RewardIngestionModule` (T-RR-010, exported
 * `RewardIngestionService`) directly, plus this task's own two providers. Every test in
 * `test/messaging/ingest/**` that needs a real broker boots this same root module directly, so this
 * file and the test suite exercise identical wiring.
 *
 * `KAFKA_CONSUMER_ENABLED` (default enabled) is this task's own Rollback lever, the same
 * `GRPC_SERVER_ENABLED` convention `grpc-server.main.ts`/`grpc-server.config.ts` already
 * established — set to `"false"` to keep this process from ever opening a broker connection,
 * rather than starting a consumer that has to be torn down separately (the task file's own
 * "Rollback" section). Read directly from `process.env`, not through `ConfigService` — same
 * reasoning `grpc-server.main.ts` already established for this agent's own standalone entry
 * points: a standalone process's own "do I even start" decision has to be resolvable before any
 * Nest application context exists at all.
 *
 * **Calls `loadDotenvFilesIntoProcessEnv()` as its very first statement** (T-RR-050,
 * `load-dotenv-files.ts`'s own header: "Call this from the very first line of every standalone
 * entry point's source ... the gRPC/Kafka bootstrap files T-RR-011/T-RR-012 add in Wave 1").
 * Without it, a real, separately-spawned process (this file run directly, never through
 * `test/database/env.setup.ts`'s own eager loader) reads `undefined` for every dotenv-only var a
 * later module pulls straight off `process.env` — `FIELD_ENCRYPTION_AES_KEY`/`_HMAC_KEY`
 * (`EncryptionModule`, transitively required by `RewardIngestionModule`) chief among them —
 * confirmed by direct reproduction while implementing this task: running this file unmodified
 * against the real local Redpanda crashed at Nest bootstrap with exactly that error before this
 * call was added. **Import position, not just call position, matters**: this import must be the
 * first line, before `ConfigModule`/`RewardIngestionModule` are ever imported, since
 * `ConfigModule`'s own `NestConfigModule.forRoot(...)` runs synchronously the moment
 * `config.module.ts` itself is `require`'d (`main.ts`'s own header has the full mechanism).
 */
import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from '@/config/load-dotenv-files';

// Deliberately before the `ConfigModule`/`RewardIngestionModule` imports below — see this file's
// own header and `main.ts`'s own header (T-RR-050) for why import/call position both matter here.
loadDotenvFilesIntoProcessEnv();

import { Module, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { RewardIngestionModule } from '@/modules/reward-ingestion/reward-ingestion.module';
import { RewardEntryCreatedDlqProducer } from './reward-entry-created-dlq.producer';
import {
  RewardEntryCreatedConsumer,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  DEFAULT_RETRY_BACKOFF_BASE_MS,
  DEFAULT_RETRY_BACKOFF_MAX_MS,
} from './reward-entry-created.consumer';

export const KAFKA_CONSUMER_ENABLED_ENV_VAR = 'KAFKA_CONSUMER_ENABLED';

@Module({
  imports: [ConfigModule, RewardIngestionModule],
  providers: [
    RewardEntryCreatedDlqProducer,
    { provide: RETRY_BACKOFF_BASE_MS, useValue: DEFAULT_RETRY_BACKOFF_BASE_MS },
    { provide: RETRY_BACKOFF_MAX_MS, useValue: DEFAULT_RETRY_BACKOFF_MAX_MS },
    RewardEntryCreatedConsumer,
  ],
})
export class KafkaConsumerRootModule {}

const logger = new Logger('KafkaConsumerBootstrap');

function isEnabled(): boolean {
  return process.env[KAFKA_CONSUMER_ENABLED_ENV_VAR] !== 'false';
}

/**
 * Returns `null` when `KAFKA_CONSUMER_ENABLED=false` (this file's own header) — callers must treat
 * `null` as "do not start this transport", not retry or fall back to any other behaviour.
 * Otherwise returns a constructed (but not yet consuming) app context; callers still need to call
 * `.get(RewardEntryCreatedConsumer).start()`.
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
      `${KAFKA_CONSUMER_ENABLED_ENV_VAR}=false — reward.entry.created.v1 consumer not started`,
    );
    return;
  }
  const consumer = app.get(RewardEntryCreatedConsumer);
  await consumer.start();
  logger.log('reward.entry.created.v1 consumer listening (shared consumer group)');
}

/* istanbul ignore next -- exercised as a real process by manual/e2e verification against a real
 * Redpanda broker, not by the automated unit suite (which boots `KafkaConsumerRootModule` directly
 * via `NestFactory.createApplicationContext` for a faster, in-process real-Postgres run). */
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error(
      'reward.entry.created.v1 consumer failed to start',
      error instanceof Error ? error.stack : error,
    );
    process.exitCode = 1;
  });
}
