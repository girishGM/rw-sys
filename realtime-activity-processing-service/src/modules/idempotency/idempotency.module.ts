import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { CorrelationIdService } from './correlation-id.service';

/**
 * T-RAP-020. Not wired into `AppModule` by this task — nothing transport-facing consumes it yet
 * (`app.module.ts` is not in this task's "Files owned" list, and Scope §"Out" excludes any
 * transport code). T-RAP-021's mapping/fan-out module imports this module directly once it lands.
 */
@Module({
  providers: [IdempotencyService, CorrelationIdService],
  exports: [IdempotencyService, CorrelationIdService],
})
export class IdempotencyModule {}
