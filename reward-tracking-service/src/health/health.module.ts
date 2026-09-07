import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DbReachabilityService } from './db-reachability.service';

@Module({
  controllers: [HealthController],
  providers: [DbReachabilityService],
})
export class HealthModule {}
