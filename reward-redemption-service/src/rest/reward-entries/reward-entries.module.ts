/**
 * T-RR-013. Wires the REST transport adapter's own controller/guard. Imports
 * `RewardIngestionModule` (T-RR-010, exported `RewardIngestionService`) rather than duplicating
 * it — the same R10 "one shared domain method, three thin adapters" convention `GrpcModule`
 * (T-RR-011) and `KafkaConsumerRootModule` (T-RR-012) both already follow.
 *
 * **Unlike `GrpcModule`/`KafkaConsumerRootModule`, this module is registered directly into the
 * real `AppModule`** (`src/app.module.ts`) rather than getting its own standalone process/root
 * module. gRPC and Kafka each have their own transport/port and no reason to share `main.ts`'s
 * HTTP listener; REST has no such option — `04-REST-CONTRACT.md`'s own "Port allocation" section
 * and `ARCHITECTURE.md` §6's own transport table ("REST (Express via Nest)") both place this
 * exact endpoint on this service's one real HTTP process, port `3030`, the same process
 * `main.ts`/`AppModule` (`agent-rr-foundation`'s file scope) already bootstraps for `/health`
 * (T-RR-004) and `POST /api/v1/cache/invalidate` (T-RR-007). `app.module.ts`'s own header
 * documents itself as exactly this: "an append-only registration point ... each task adds its own
 * module import line here and touches nothing else in this file, so two agents working in
 * parallel ... never collide" — the one line this task adds there is that append, not an edit to
 * any of `AppModule`'s existing content (`AGENT-PROTOCOL.md` R3's own "registration points ... are
 * append-only" carve-out). Flagged here and in this task's own completion report as the one
 * deliberate exception to this task's stated "Files owned" list, for the record.
 */
import { Module } from '@nestjs/common';
import { RewardIngestionModule } from '@/modules/reward-ingestion/reward-ingestion.module';
import { RewardEntriesController } from './reward-entries.controller';
import { IngestTokenGuard } from './ingest-token.guard';

@Module({
  imports: [RewardIngestionModule],
  controllers: [RewardEntriesController],
  providers: [IngestTokenGuard],
})
export class RewardEntriesModule {}
