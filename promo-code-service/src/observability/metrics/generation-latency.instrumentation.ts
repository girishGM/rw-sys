/**
 * T-PC-042, implementation note 6: "instrumented once, inside T-PC-021's own service (a metrics
 * wrapper/decorator this task adds, not a change to T-PC-021's own owned files' logic —
 * coordinate the exact integration point so this task's instrumentation doesn't require editing
 * another task's owned file in a way that violates R8; prefer a NestJS interceptor or a wrapping
 * call this task's own module registers)."
 *
 * A NestJS interceptor cannot reach `PromoCodeGenerationService.generateCode()` here: interceptors
 * bind to *controller* methods via a module's own DI tree (`APP_INTERCEPTOR`/`@UseInterceptors`),
 * and every controller that ultimately calls `generateCode()` (`PromoCodeController` for gRPC,
 * `GenerateRequestedConsumer` for Kafka — not even a controller, a plain injectable driven by a
 * manual `kafkajs` loop) lives in `src/grpc/**`/`src/messaging/**`, `agent-promo-messaging`'s own
 * file scope (R8) — this task cannot add `@UseInterceptors()` there, and cannot add a global
 * `APP_INTERCEPTOR` provider to `GrpcServerModule`/`KafkaConsumerModule` either, both squarely
 * outside `src/observability/**`.
 *
 * So this is literally "a wrapping call this task's own module registers": on module init, this
 * provider takes the *live, DI-managed* `PromoCodeGenerationService` singleton already present in
 * whatever application container imported both `PromoCodeGenerationModule` and this task's own
 * `MetricsModule` (Nest instantiates a non-dynamic module's providers exactly once per
 * application graph, so every importer of `PromoCodeGenerationModule` within one process shares
 * the same instance — no new copy is created) and replaces that one instance's own
 * `generateCode` method with a timed, metrics-recording wrapper — a shadowing own-property
 * assignment, not an edit to `promo-code-generation.service.ts` itself.
 *
 * **Known limitation, flagged in this task's own completion report**: this only takes effect in
 * whichever process's own DI container actually imports this task's `MetricsModule` — today, only
 * the HTTP `AppModule` process (via the `app.module.ts` append-only registration point). The
 * standalone gRPC (`GrpcMicroserviceRootModule`) and Kafka (`KafkaConsumerRootModule`) processes —
 * where `generateCode()` is actually invoked in production — each construct their own, separate
 * `PromoCodeGenerationService` instance in a separate OS process/DI graph that this task cannot
 * reach without editing `agent-promo-messaging`'s own files. See this task's completion report and
 * the defect filed against that gap.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PromoCodeGenerationService } from '../../modules/generation/promo-code-generation.service';
import type { GenerationResult } from '../../modules/generation/generation-result.types';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import { MetricsService, type GenerationTransport } from './metrics.service';

function resolveTransport(input: unknown): GenerationTransport {
  if (input && typeof input === 'object' && 'transport' in input) {
    const transport = (input as { transport?: unknown }).transport;
    if (transport === 'KAFKA' || transport === 'GRPC') {
      return transport;
    }
  }
  return 'GRPC';
}

@Injectable()
export class GenerationLatencyInstrumentation implements OnModuleInit {
  private installed = false;

  constructor(
    private readonly generationService: PromoCodeGenerationService,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;

    const original = this.generationService.generateCode.bind(this.generationService);

    this.generationService.generateCode = async (input: unknown): Promise<GenerationResult> => {
      const transport = resolveTransport(input);
      const startedAt = process.hrtime.bigint();
      const result = await original(input);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      this.metrics.recordGenerationLatency(durationMs, transport);
      this.metrics.incrementCodesGenerated(transport, result.status);

      return result;
    };

    this.logger.debug(
      'Generation latency/codes-generated instrumentation installed on the live PromoCodeGenerationService instance',
      GenerationLatencyInstrumentation.name,
    );
  }
}
