/**
 * T-PC-042. The one module `AppModule` (an append-only registration point, same T-PC-010/012/
 * 021/022 precedent) needs to import to get structured logging + correlationId tracing +
 * `/metrics` for the HTTP transport process. See this task's own completion report for the known
 * gap this alone does *not* close: the standalone gRPC/Kafka processes each run their own,
 * separate DI container that only `agent-promo-messaging`'s own files can wire this into (R8).
 */
import { Module } from '@nestjs/common';
import { LoggingModule } from './logging/logging.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [LoggingModule, MetricsModule],
  exports: [LoggingModule, MetricsModule],
})
export class ObservabilityModule {}
