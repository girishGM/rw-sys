/**
 * T-RR-023. Wires `ExternalRewardSystemConfigResolver` and `RetryClassificationService` so
 * T-RR-024's retry orchestration (and T-RR-030's connector registry, which also `depends on` this
 * task per `progress.json`) can import this module directly and get both.
 *
 * Imports `TenantSchemaCacheModule` (T-RR-007, `agent-rr-foundation`'s own file scope) for
 * `ExternalRewardSystemConfigCache` — `ExternalRewardSystemConfigResolver`'s own dependency. That
 * module's own header explicitly anticipates this import ("any later Wave 2+ consumer
 * (T-RR-022/T-RR-023/T-RR-033) can import this module directly"), the same convention
 * `ProcessingModule` (T-RR-022) already relies on for `ServiceConfigCache`.
 *
 * Not wired into `AppModule` by this task — the same convention `ClaimWorkerModule` (T-RR-020),
 * `RedemptionStateMachineModule` (T-RR-021) and `ProcessingModule` (T-RR-022) already established:
 * `AppModule` is not in this task's own "Files owned" list, and nothing transport-facing calls
 * into retry classification yet — T-RR-024, not yet built, is the first real caller.
 */
import { Module } from '@nestjs/common';
import { TenantSchemaCacheModule } from '@/modules/tenant-schema-cache/tenant-schema-cache.module';
import { ExternalRewardSystemConfigResolver } from './external-reward-system-config.resolver';
import { RetryClassificationService } from './retry-classification.service';

@Module({
  imports: [TenantSchemaCacheModule],
  providers: [ExternalRewardSystemConfigResolver, RetryClassificationService],
  exports: [ExternalRewardSystemConfigResolver, RetryClassificationService],
})
export class RewardSystemConfigModule {}
