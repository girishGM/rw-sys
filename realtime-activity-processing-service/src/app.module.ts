import { Module } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { HealthModule } from '@/health/health.module';

/**
 * Append-only registration point, same convention as portal/back-end's own `app.module.ts` and
 * promo-code-service's own `app.module.ts`: each task adds its own module import line here and
 * touches nothing else in this file, so two agents working in parallel (Wave 1 onward) never
 * collide on this file's content.
 */
@Module({
  imports: [ConfigModule, HealthModule],
})
export class AppModule {}
