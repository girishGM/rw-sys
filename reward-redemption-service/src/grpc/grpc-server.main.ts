/**
 * T-RR-011. Standalone composition root for the mTLS `RewardIngestService` gRPC transport, run as
 * its own process — **not** wired into `src/main.ts`'s HTTP bootstrap.
 *
 * ### Why a separate entry point instead of a hybrid app in `main.ts`
 *
 * `src/main.ts`/`src/app.module.ts` are both exclusively `agent-rr-foundation`'s file scope
 * (`reward-redemption-service-plan/project.config.json`); this agent's own delegated scope is
 * `src/grpc/**`/`src/messaging/ingest/**`/`src/rest/reward-entries/**`/
 * `src/modules/reward-ingestion/**`/`proto/**`/matching `test/**` dirs. Rather than edit either
 * foundation-owned file, this task ships a fully self-contained composition root instead — its own
 * tiny root module (`GrpcMicroserviceRootModule` below, importing the `@Global` `ConfigModule` —
 * needed transitively because `RewardIngestionModule` -> `RewardRedemptionEntryRepository` injects
 * `ConfigService<Config, true>` — and this task's own `GrpcModule`) and its own
 * `NestFactory.createMicroservice(...)` bootstrap. Every test in `test/grpc/**` boots this same
 * root module directly, so this file and the test suite exercise identical wiring. Same precedent
 * `realtime-activity-processing-service/src/grpc/grpc-server.main.ts` (T-RAP-022, confirmed by
 * direct read) already set for the sibling project, for the identical file-scope reason.
 *
 * **Follow-up flagged for the architect/reviewer** (this task's own completion report): running
 * this as a second OS process alongside `main.ts`'s HTTP process is a legitimate, working
 * deployment shape (`ARCHITECTURE.md` never mandates one process), but folding it into a single
 * hybrid process via `main.ts` — if that is the preferred production topology — is a follow-up for
 * `agent-rr-foundation`, since it requires editing a file outside this task's scope.
 *
 * ### Rollback
 *
 * `buildGrpcMicroserviceOptions()` returns `null` when `GRPC_SERVER_ENABLED=false` — this process
 * then logs and exits `0` without ever opening a socket, rather than starting a listener that has
 * to be torn down separately (the task file's own "Rollback" section).
 *
 * **T-RR-012 fix-forward note.** `loadDotenvFilesIntoProcessEnv()` was missing from this file even
 * though `load-dotenv-files.ts`'s own header (T-RR-050) explicitly names "the gRPC/Kafka bootstrap
 * files T-RR-011/T-RR-012 add in Wave 1" as needing this call — confirmed by direct reproduction
 * while implementing T-RR-012's own `kafka-consumer.main.ts` (the identical gap, same symptom: a
 * real, separately-spawned process crashes at Nest bootstrap on `FIELD_ENCRYPTION_AES_KEY is
 * required`, since that var is dotenv-only and never reaches `process.env` any other way for a
 * process that doesn't go through Jest's own `test/database/env.setup.ts`). Fixed here rather than
 * filed as a separate defect: `src/grpc/**` is this same agent's (`agent-rr-ingestion`) own file
 * scope, not a different agent's exclusive territory, and the fix is the identical, already-proven
 * one-line pattern `main.ts`/`kafka-consumer.main.ts` both already use. Flagged explicitly in
 * T-RR-012's own completion report as a deviation from that task's stated scope, for the record.
 */
import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from '@/config/load-dotenv-files';

// Deliberately before the `ConfigModule`/`GrpcModule` imports below — see this file's own header
// note above and `main.ts`'s own header (T-RR-050) for why import/call position both matter here.
loadDotenvFilesIntoProcessEnv();

import { Module, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestMicroservice } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { GrpcModule } from './grpc.module';
import { buildGrpcMicroserviceOptions } from './grpc-server.bootstrap';

@Module({
  imports: [ConfigModule, GrpcModule],
})
export class GrpcMicroserviceRootModule {}

const logger = new Logger('GrpcServerBootstrap');

/**
 * Returns `null` when `GRPC_SERVER_ENABLED=false` (same "transport deliberately absent" meaning
 * `buildGrpcMicroserviceOptions()` already carries), otherwise a real, not-yet-listening
 * `INestMicroservice`. Callers still need to `await app.listen()`.
 */
export async function createGrpcMicroservice(): Promise<INestMicroservice | null> {
  const options = buildGrpcMicroserviceOptions();
  if (options === null) {
    return null;
  }
  return NestFactory.createMicroservice(GrpcMicroserviceRootModule, options);
}

export async function bootstrap(): Promise<void> {
  const app = await createGrpcMicroservice();
  if (app === null) {
    logger.warn('GRPC_SERVER_ENABLED=false — gRPC transport not started');
    return;
  }
  await app.listen();
  logger.log('RewardIngestService gRPC server listening (mTLS)');
}

/* istanbul ignore next -- exercised as a real process by manual grpcurl verification, not by the
 * automated suite (which boots `GrpcMicroserviceRootModule` directly via
 * `NestFactory.createMicroservice` for a faster, in-process real-Postgres/real-mTLS run — see
 * `test/grpc/reward-ingest.e2e-spec.ts`). */
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error('gRPC server failed to start', error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
