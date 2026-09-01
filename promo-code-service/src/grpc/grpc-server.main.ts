/**
 * T-PC-031. Standalone composition root for the mTLS gRPC transport, run as its own process on
 * port `50061` — **not** wired into `src/main.ts`'s HTTP bootstrap.
 *
 * ### Why a separate entry point instead of a hybrid app in `main.ts`
 *
 * `src/main.ts` and `src/app.module.ts` are both exclusively `agent-promo-foundation`'s file
 * scope (`project.config.json`); this agent's own delegated scope is `src/grpc/**`/
 * `src/messaging/**`/`proto/**`/`test/grpc/**`/`test/messaging/**` (same file-scope discipline
 * `internal-service-token.guard.ts`'s header, T-PC-011, already established for this project).
 * Rather than edit either foundation-owned file — even the mechanical "add one module to an
 * imports array" the append-only convention (`AGENT-PROTOCOL.md` R8) allows for a registration
 * point, since a hybrid-app `connectMicroservice`/`startAllMicroservices()` bootstrap sequence
 * in `main.ts` is a real design decision (ordering, credential-loading failure handling) and not
 * a mechanical one-liner — this task ships a fully self-contained composition root instead: its
 * own tiny root module (`GrpcMicroserviceRootModule` below) that imports only `ConfigModule`
 * (`@Global`, needed for every `ConfigService` injection in the module tree below it) and this
 * task's own `GrpcServerModule`, and its own `NestFactory.createMicroservice(...)` bootstrap.
 * Every test in `test/grpc/**` boots this same root module directly (via `Test.createTestingModule`),
 * so this file and the test suite exercise identical wiring.
 *
 * **Follow-up flagged for the architect/reviewer** (this task's own completion report): running
 * this as a second OS process alongside `main.ts`'s HTTP process is a legitimate, working
 * deployment shape (`ARCHITECTURE.md` never mandates one process), but folding it into a single
 * hybrid process via `main.ts` — if that is the preferred production topology — is a follow-up
 * for `agent-promo-foundation`, since it requires editing files outside this task's scope.
 *
 * ### Rollback
 *
 * `buildGrpcMicroserviceOptions()` returns `null` when `GRPC_SERVER_ENABLED=false` — this
 * process then logs and exits `0` without ever opening a socket, rather than starting a listener
 * that has to be torn down separately (the task file's own "Rollback" section).
 */
import 'reflect-metadata';
import { Module, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '../config/config.module';
import { GrpcServerModule } from './grpc-server.module';
import { buildGrpcMicroserviceOptions } from './grpc-server.bootstrap';

@Module({
  imports: [ConfigModule, GrpcServerModule],
})
export class GrpcMicroserviceRootModule {}

const logger = new Logger('GrpcServerBootstrap');

export async function bootstrap(): Promise<void> {
  const options = buildGrpcMicroserviceOptions();
  if (options === null) {
    logger.warn('GRPC_SERVER_ENABLED=false — gRPC transport not started');
    return;
  }

  const app = await NestFactory.createMicroservice(GrpcMicroserviceRootModule, options);
  await app.listen();
  logger.log(`gRPC server listening (mTLS) — ${options.options.url}`);
}

/* istanbul ignore next -- exercised as a real process by manual grpcurl verification, not by the
 * automated suite (which boots `GrpcMicroserviceRootModule` directly via `Test.createTestingModule`
 * for a faster, in-process real-Postgres/real-mTLS run — see `test/grpc/grpc-server.e2e-spec.ts`). */
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error('gRPC server failed to start', error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
