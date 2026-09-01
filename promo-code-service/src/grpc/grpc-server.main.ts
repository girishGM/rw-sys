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
 *
 * ### T-PC-048 — this process's own `GET /metrics`
 *
 * Before this change, `GrpcMicroserviceRootModule` bootstrapped via
 * `NestFactory.createMicroservice(...)`, a gRPC-only listener with no HTTP capability at all — so
 * even after `grpc-server.module.ts`'s own T-PC-048 fix (`GrpcServerModule` importing
 * `MetricsModule`, which wraps *this* process's own live `PromoCodeGenerationService` instance and
 * increments its own in-memory `codes_generated_total`/`promo_code_generation_duration_seconds`),
 * nothing could ever scrape it: a Prometheus target aimed at the HTTP `AppModule` process reads a
 * completely different process's own separate in-memory registry, which never saw a gRPC call at
 * all. `createGrpcHybridApp()` below builds a **hybrid** Nest application instead
 * (`NestFactory.create()` + `connectMicroservice()`, the standard Nest pattern for a process that
 * needs both a microservice transport and its own HTTP surface) — the same DI graph as before,
 * plus a real Express HTTP adapter this process's own `MetricsController` (imported transitively
 * via `MetricsModule`) can now actually bind `GET /metrics` to. Exported (not just inlined into
 * `bootstrap()`) specifically so `test/grpc/grpc-server-metrics.e2e-spec.ts` boots the exact same
 * wiring a real deployment does, rather than a parallel, potentially-drifting test-only setup.
 */
import 'reflect-metadata';
import { Module, Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { GrpcOptions } from '@nestjs/microservices';
import { ConfigModule } from '../config/config.module';
import { GrpcServerModule } from './grpc-server.module';
import { buildGrpcMicroserviceOptions } from './grpc-server.bootstrap';
import { isGrpcMetricsListenerEnabled, parseGrpcMetricsPort } from './grpc-server.config';

@Module({
  imports: [ConfigModule, GrpcServerModule],
})
export class GrpcMicroserviceRootModule {}

const logger = new Logger('GrpcServerBootstrap');

/**
 * Returns `null` when `GRPC_SERVER_ENABLED=false` (same "transport deliberately absent" meaning
 * `buildGrpcMicroserviceOptions()` already carries — see that function's own header), otherwise a
 * hybrid `INestApplication` with the gRPC microservice already `connectMicroservice()`-attached
 * (not yet started — call `app.startAllMicroservices()`) and not yet listening for HTTP (call
 * `app.listen(port)` once ready, or `app.init()` alone to skip the `GET /metrics` HTTP listener
 * while still instantiating every provider, mirroring `GRPC_METRICS_ENABLED=false`).
 */
export async function createGrpcHybridApp(): Promise<{
  app: INestApplication;
  grpcOptions: GrpcOptions;
} | null> {
  const options = buildGrpcMicroserviceOptions();
  if (options === null) {
    return null;
  }
  const app = await NestFactory.create(GrpcMicroserviceRootModule);
  app.connectMicroservice(options);
  return { app, grpcOptions: options };
}

export async function bootstrap(): Promise<void> {
  const created = await createGrpcHybridApp();
  if (created === null) {
    logger.warn('GRPC_SERVER_ENABLED=false — gRPC transport not started');
    return;
  }
  const { app, grpcOptions } = created;

  await app.startAllMicroservices();

  if (isGrpcMetricsListenerEnabled()) {
    const metricsPort = parseGrpcMetricsPort();
    await app.listen(metricsPort);
    logger.log(`gRPC process metrics listening — GET http://0.0.0.0:${metricsPort}/metrics`);
  } else {
    await app.init();
    logger.warn("GRPC_METRICS_ENABLED=false — this process's own GET /metrics not started");
  }

  logger.log(`gRPC server listening (mTLS) — ${grpcOptions.options.url}`);
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
