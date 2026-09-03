/**
 * T-RAP-022. Standalone composition root for the mTLS `ActivityIngestService` gRPC transport, run
 * as its own process — **not** wired into `src/main.ts`'s HTTP bootstrap.
 *
 * ### Why a separate entry point instead of a hybrid app in `main.ts`
 *
 * `src/main.ts`/`src/app.module.ts` are both exclusively `agent-rap-foundation`'s file scope
 * (`realtime-activity-processing-service-plan/project.config.json`); this agent's own delegated
 * scope is `src/grpc/**`/`src/messaging/ingest/**`/`proto/**`/`test/grpc/**`/
 * `test/messaging/ingest/**`. Rather than edit either foundation-owned file, this task ships a
 * fully self-contained composition root instead — its own tiny root module
 * (`GrpcMicroserviceRootModule` below, importing only the `@Global` `ConfigModule` and this task's
 * own `GrpcModule`) and its own `NestFactory.createMicroservice(...)` bootstrap. Every test in
 * `test/grpc/**` boots this same root module directly, so this file and the test suite exercise
 * identical wiring. Same precedent `promo-code-service/src/grpc/grpc-server.main.ts` (T-PC-031)
 * already set for the sibling project, for the identical file-scope reason.
 *
 * **Follow-up flagged for the architect/reviewer** (this task's own completion report): running
 * this as a second OS process alongside `main.ts`'s HTTP process is a legitimate, working
 * deployment shape (`ARCHITECTURE.md` never mandates one process), but folding it into a single
 * hybrid process via `main.ts` — if that is the preferred production topology — is a follow-up for
 * `agent-rap-foundation`, since it requires editing a file outside this task's scope.
 *
 * ### Rollback
 *
 * `buildGrpcMicroserviceOptions()` returns `null` when `GRPC_SERVER_ENABLED=false` — this process
 * then logs and exits `0` without ever opening a socket, rather than starting a listener that has
 * to be torn down separately (the task file's own "Rollback" section).
 */
import 'reflect-metadata';
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
  logger.log('ActivityIngestService gRPC server listening (mTLS)');
}

/* istanbul ignore next -- exercised as a real process by manual grpcurl verification, not by the
 * automated suite (which boots `GrpcMicroserviceRootModule` directly via
 * `NestFactory.createMicroservice` for a faster, in-process real-Postgres/real-mTLS run — see
 * `test/grpc/grpc-server.e2e-spec.ts`). */
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error('gRPC server failed to start', error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
