import { Module } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { HealthModule } from '@/health/health.module';
import { PromoCodeConfigModule } from '@/modules/promo-code-config/promo-code-config.module';
import { CampaignBindingModule } from '@/modules/campaign-binding/campaign-binding.module';
import { PromoCodeGenerationModule } from '@/modules/generation/promo-code-generation.module';
import { GenerationModule } from '@/modules/generation/generation.module';
import { OutboxPublisherModule } from '@/modules/outbox/outbox-publisher.module';
import { ObservabilityModule } from '@/observability/observability.module';

/**
 * Append-only registration point, same convention as portal/back-end's own `app.module.ts`:
 * each task adds its own module import line here and touches nothing else in this file, so
 * two agents working in parallel (T-PC-010/011/012 in Wave 1 onward) never collide on this
 * file's content.
 *
 * `PromoCodeConfigModule` added by T-PC-010 (AGENT-PROTOCOL.md R8 — this file is an
 * append-only registration point, not `agent-promo-config`'s own owned file; only this one
 * import line + list entry were touched).
 *
 * `CampaignBindingModule` added by T-PC-012, same append-only convention — only this import
 * line + list entry touched, nothing else in this file.
 *
 * `PromoCodeGenerationModule` added by T-PC-021, same append-only convention — only this import
 * line + list entry touched. No transport adapter (T-PC-030/T-PC-031) exists yet, so nothing
 * calls `PromoCodeGenerationService` through the running app yet; registering it here now is
 * what makes the Rollback section of that task's own task file ("remove the import — zero live
 * callers before Wave 3") meaningful.
 *
 * `GenerationModule` added by T-PC-056, same append-only convention — only this import line +
 * list entry touched. This registers the REST transport adapter (`POST
 * /api/v1/promo-codes/generate`, `GenerationServiceTokenGuard`/`...StartupCheck`) alongside
 * `PromoCodeGenerationModule` (the transport-neutral domain module, unchanged by this task).
 * `promo-code-service/src/app.module.ts` and `promo-code-service/test/jest-e2e.setup.ts` are not
 * literally inside `agent-promo-generation`'s own `project.config.json` grant (which predates this
 * Wave-4 follow-up task) — this append follows the exact precedent `PromoCodeGenerationModule`'s
 * own entry below already set for the same agent/file pair (T-PC-021), consistent with R8's
 * "registration points... are append-only" carve-out: only one import line + one list entry
 * touched in each file, nothing else. See this task's completion report, "Deviations from spec".
 *
 * `OutboxPublisherModule` added by T-PC-022, same append-only convention — only this import line
 * + list entry touched. `OutboxPublisherWorker.onModuleInit` only actually starts its own
 * `setInterval` poller when `OUTBOX_PUBLISHER_AUTOSTART` resolves `true`
 * (`outbox-publisher.config.ts`), which defaults to "on" everywhere except `NODE_ENV=test` — so
 * every `*.e2e-spec.ts` in this project (most of which boot the full `AppModule` for reasons
 * having nothing to do with the outbox) never races a live poller against a real, global,
 * un-scoped `promo_code_outbox` query while another suite's own rows exist. `KafkaProducerService`
 * itself also only ever connects lazily on an actual publish attempt (see that file's own header),
 * so booting this module never depends on a broker being reachable either way.
 *
 * `ObservabilityModule` added by T-PC-042, same append-only convention — only this import line +
 * list entry touched. Installs the process-wide structured (JSON) logger, an `x-correlation-id`
 * HTTP middleware applied to every route, and `GET /metrics` (Prometheus text exposition format).
 * Only takes effect in *this* process (the HTTP transport) — the standalone gRPC/Kafka processes
 * (`grpc-server.main.ts`/`kafka-consumer.main.ts`, `agent-promo-messaging`'s own files, R8) are not
 * reachable from this task's own file scope; see that task's completion report and the defect
 * filed against that gap.
 */
@Module({
  imports: [
    ConfigModule,
    HealthModule,
    PromoCodeConfigModule,
    CampaignBindingModule,
    PromoCodeGenerationModule,
    GenerationModule,
    OutboxPublisherModule,
    ObservabilityModule,
  ],
})
export class AppModule {}
