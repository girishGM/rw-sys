/**
 * T-PC-042. Imports `PromoCodeConfigModule` (T-PC-010, exported `PROMO_CODE_SEQUELIZE`) rather
 * than opening a second Postgres connection — same "no second copy of the pool" convention every
 * other module in this schema follows (`grpc-server.module.ts`'s own header). Imports
 * `PromoCodeGenerationModule` (T-PC-021) purely so `GenerationLatencyInstrumentation` can inject
 * the live `PromoCodeGenerationService` singleton to wrap — see that file's own header for the
 * "same process/DI-graph only" limitation this carries.
 */
import { Module } from '@nestjs/common';
import { PromoCodeConfigModule } from '../../modules/promo-code-config/promo-code-config.module';
import { PromoCodeGenerationModule } from '../../modules/generation/promo-code-generation.module';
import { LoggingModule } from '../logging/logging.module';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { GenerationLatencyInstrumentation } from './generation-latency.instrumentation';

@Module({
  imports: [PromoCodeConfigModule, PromoCodeGenerationModule, LoggingModule],
  controllers: [MetricsController],
  providers: [MetricsService, GenerationLatencyInstrumentation],
  exports: [MetricsService],
})
export class MetricsModule {}
