/**
 * T-RR-022. Wires this task's own three providers — `CampaignConfigClient`, `CampaignConfigCache`
 * (the fifth cache, `06-CACHING-AND-TENANT-CONFIG.md` §1) and `RewardSystemResolutionService` —
 * so a Wave 2/3 consumer (T-RR-023's retry classification, T-RR-024's retry orchestration) can
 * import this module and get all three.
 *
 * **T-RR-065 (defect fix)** adds a fourth provider, `TenantSchemaEnrichmentService` — declared in
 * the same file as `RewardSystemResolutionService` (that file's own T-RR-065 header explains why)
 * and wired here so `RedemptionProcessingOrchestrator` (via `ClaimWorkerModule`, which already
 * imports this module) can inject it through real Nest DI without either file needing any further
 * change. `TenantSchemaConfigCache` (its own DB-backed dependency) is already available here via
 * `TenantSchemaCacheModule`, imported below for `ServiceConfigCache` since T-RR-022 first landed.
 *
 * Deliberately a separate module from `ClaimWorkerModule` (T-RR-020, `claim-worker.module.ts`),
 * not a merge into it: that module is T-RR-020's own file, outside this task's "Files owned" list
 * (R3's "do not edit another task's owned files" applies between tasks owned by the same agent
 * too, per this plan's own per-task file-scope discipline).
 *
 * Imports `TenantSchemaCacheModule` (T-RR-007, `agent-rr-foundation`'s own file scope) for
 * `ServiceConfigCache` — `CampaignConfigCache`'s own TTL resolution dependency. That module's own
 * header explicitly documents this as an anticipated import ("any later Wave 2+ consumer
 * (T-RR-022/T-RR-023/T-RR-033) can import this module directly"), so this is normal cross-module
 * consumption of an already-exported provider, not an edit to any file `agent-rr-foundation` owns.
 *
 * **Not wired into `AppModule` by this task** — same convention `ClaimWorkerModule` (T-RR-020) and
 * `RedemptionStateMachineModule` (T-RR-021) already established: `AppModule` isn't in this task's
 * own "Files owned" list, and nothing transport-facing calls into this resolution step yet
 * (T-RR-023/T-RR-024, not yet built, are the first real callers).
 */
import { Module } from '@nestjs/common';
import { TenantSchemaCacheModule } from '@/modules/tenant-schema-cache/tenant-schema-cache.module';
import { CampaignConfigCache } from './campaign-config.cache';
import { CampaignConfigClient } from './campaign-config.client';
import {
  RewardSystemResolutionService,
  TenantSchemaEnrichmentService,
} from './reward-system-resolution.service';

@Module({
  imports: [TenantSchemaCacheModule],
  providers: [
    CampaignConfigClient,
    CampaignConfigCache,
    RewardSystemResolutionService,
    TenantSchemaEnrichmentService,
  ],
  exports: [
    CampaignConfigClient,
    CampaignConfigCache,
    RewardSystemResolutionService,
    TenantSchemaEnrichmentService,
  ],
})
export class ProcessingModule {}
