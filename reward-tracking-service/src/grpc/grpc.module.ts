/**
 * T-RTS-011. Wires the gRPC transport adapter's own provider. Imports
 * `RewardTrackingIngestionModule` (T-RTS-010, exported `RewardTrackingIngestionService`) rather
 * than duplicating it — the R8 "one shared domain method, three thin adapters" convention this
 * whole wave follows.
 *
 * **Not registered in `AppModule`'s own imports by this task** — `app.module.ts` is exclusively
 * `agent-rts-foundation`'s file scope (`reward-tracking-service-plan/project.config.json`), same
 * gap `T-RTS-020`'s own `campaign-cache.module.ts` already flagged and left for a later wiring
 * step. This module is fully self-contained and independently testable/runnable instead: real
 * process startup goes through `grpc-server.main.ts` (this task's own standalone composition
 * root, alongside this file, mirroring `reward-redemption-service`'s own `T-RR-011`
 * `grpc-server.main.ts` precedent — confirmed by direct read — for the identical file-scope
 * reason: this agent's delegated scope is `src/grpc/**`/`src/kafka/**`/
 * `src/modules/ingestion/**`/`proto/**`/matching `test/**` dirs, never `src/app.module.ts`).
 * Folding this into a single hybrid process via `src/main.ts` — if that is the preferred
 * production topology — is a follow-up for `agent-rts-foundation` (flagged in this task's own
 * completion report), since it requires editing a file outside this task's scope.
 */
import { Module } from '@nestjs/common';
import { RewardTrackingIngestionModule } from '@/modules/ingestion/reward-tracking-ingestion.module';
import { LoggingModule } from '@/observability/logging.module';
import { RewardTrackingIngestGrpcController } from './reward-tracking-ingest.grpc-controller';

@Module({
  // T-RTS-049 — `LoggingModule` also comes in transitively via `RewardTrackingIngestionModule`
  // (Nest dedupes an identically-referenced module class across one dependency graph, so this
  // stays a single `MetricsService`/`StructuredLoggerFactory` singleton per process); imported
  // here explicitly too since this module's own controller injects both directly.
  imports: [RewardTrackingIngestionModule, LoggingModule],
  providers: [RewardTrackingIngestGrpcController],
  exports: [RewardTrackingIngestGrpcController],
})
export class GrpcModule {}
