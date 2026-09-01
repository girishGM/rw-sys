/**
 * T-PC-031. Wires the gRPC transport adapter's own providers/controller. Imports
 * `PromoCodeGenerationModule` (T-PC-021, exported `PromoCodeGenerationService`) and
 * `PromoCodeConfigModule` (T-PC-010, exported `PROMO_CODE_SEQUELIZE` + `PromoCodeConfigRepository`)
 * rather than duplicating either — same "no second Postgres connection, no second copy of a
 * service" convention every other module in this schema already follows
 * (`campaign-binding.module.ts`'s own header). `ServiceIdentityRepository` reuses the same
 * `PROMO_CODE_SEQUELIZE` pool for its own table (`grpc_service_identity`, migration `008`).
 *
 * **T-PC-047.** Also imports `LoggingModule` (`src/observability/logging/logging.module.ts`, owned
 * by `agent-promo-qa`/T-PC-042 — this is a `Read`, not an `Edit`, of that file). This is the fix for
 * the defect T-PC-042 reported and could not close itself (R8: `src/observability/**` isn't its
 * file scope's neighbour, `src/grpc/**` is): `GrpcMicroserviceRootModule`
 * (`grpc-server.main.ts`) constructs its own, entirely separate `NestFactory` DI container from the
 * HTTP `AppModule` — `LoggingModule`'s `Logger.overrideLogger(...)` (installed in *that* module's
 * own constructor) only ever ran in the HTTP process before this change. Importing it here, one
 * level down from the root module rather than only in `grpc-server.main.ts` itself, means both the
 * real standalone process (`GrpcMicroserviceRootModule` importing this module) *and* every test that
 * boots this module directly via `Test.createTestingModule` (`grpc-server.e2e-spec.ts`,
 * `promo-code.controller.spec.ts`) get the identical wiring, with nothing left to duplicate in
 * `grpc-server.main.ts`. `LoggingModule` also exports `CorrelationContextService`, which
 * `PromoCodeController` now injects to run each RPC inside `CorrelationContextService.run(...)`.
 *
 * **T-PC-048.** Also imports `MetricsModule` (`src/observability/metrics/metrics.module.ts`, owned
 * by `agent-promo-qa`/T-PC-042 — a `Read`, not an `Edit`, of that file, same precedent this
 * module's own T-PC-047 note already set for `LoggingModule`). This is the fix for the defect
 * T-PC-042 reported and could not close itself (R8): `GenerationLatencyInstrumentation` (T-PC-042)
 * only wraps the live `PromoCodeGenerationService` singleton *within whichever process's own DI
 * container imports `MetricsModule`* — before this change, only the HTTP `AppModule` process did,
 * so `codes_generated_total`/`promo_code_generation_duration_seconds` never moved for the real
 * gRPC generation path this process alone actually serves in production. Importing it here gives
 * this process's own `PromoCodeGenerationService` instance the same wrapping. Exposing this
 * process's own `GET /metrics` HTTP endpoint (the other half of this defect — a scraper still
 * needs *something* to hit) is `grpc-server.main.ts`'s own T-PC-048 change, not this module's.
 */
import { Module } from '@nestjs/common';
import { PromoCodeGenerationModule } from '../modules/generation/promo-code-generation.module';
import { PromoCodeConfigModule } from '../modules/promo-code-config/promo-code-config.module';
import { LoggingModule } from '../observability/logging/logging.module';
import { MetricsModule } from '../observability/metrics/metrics.module';
import { ServiceIdentityRepository } from './service-identity.repository';
import { MtlsGuard } from './mtls.guard';
import { PromoCodeController } from './promo-code.controller';

@Module({
  imports: [PromoCodeGenerationModule, PromoCodeConfigModule, LoggingModule, MetricsModule],
  controllers: [PromoCodeController],
  providers: [ServiceIdentityRepository, MtlsGuard],
})
export class GrpcServerModule {}
