import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { CustomerRewardsApiModule } from './modules/api/customer-rewards-api.module';
import { AdminRewardsApiModule } from './modules/api/admin-rewards-api.module';

/**
 * Append-only registration point, same convention as the portal's and every sibling service's own
 * `app.module.ts`: each task adds its own module import line here and touches nothing else in this
 * file, so two agents working in parallel (Wave 1 onward) never collide on this file's content.
 */
@Module({
  imports: [ConfigModule, HealthModule, CustomerRewardsApiModule, AdminRewardsApiModule],
})
export class AppModule {}
