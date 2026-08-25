/**
 * T-052 — the metrics seam, global for the same reason `LoggerModule` is (T-019's own header):
 * an event worth counting (a login, a permission denial, a decrypt failure) happens inside
 * whichever module owns that code, not inside this one, so every module in the graph needs to
 * be able to `@Inject(MetricsRegistry)` without adding an explicit import edge back to
 * `modules/health`. Nothing here is served publicly through this module's own routes — see
 * `metrics-server.ts` for the separate, unregistered listener `main.ts` starts on
 * `METRICS_PORT`, and `metrics.middleware.ts` for the one thing this module wires up itself
 * (HTTP request rate/latency/status, the metrics this task's own files can measure honestly —
 * see `metrics.registry.ts`'s header for what is deliberately left for the owning modules to
 * populate through this same seam).
 */
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { DatabaseModule } from '@/database/database.module';
import { DbPoolSampler } from './db-pool.sampler';
import { MetricsMiddleware } from './metrics.middleware';
import { MetricsRegistry } from './metrics.registry';
import { MetricsServerService } from './metrics-server.service';

@Global()
@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [MetricsRegistry, DbPoolSampler, MetricsMiddleware, MetricsServerService],
  exports: [MetricsRegistry, DbPoolSampler, MetricsMiddleware],
})
export class MetricsModule {}
