/**
 * T-RR-058 (defect fix). Before this task, this module provided only `ClaimWorkerService`'s own
 * two direct dependencies — `RedemptionProcessingOrchestrator` (T-RR-024) was never a provider
 * here, was never imported by anything reachable from `AppModule`, and `ClaimWorkerService` never
 * called it (`claim-worker.service.ts`'s own T-RR-058 note) — so a claimed row was never actually
 * driven anywhere. This module now imports every module `RedemptionProcessingOrchestrator`'s own
 * constructor needs (`redemption-processing-orchestrator.service.ts`'s own dependency list) and
 * provides the orchestrator itself, so `ClaimWorkerService` can inject a real, fully-wired one.
 *
 * **Why `RedemptionProcessingOrchestrator` is provided here and not in `ProcessingModule`**:
 * `processing.module.ts` is T-RR-022's own file, not this task's own "Files owned" list
 * (`tasks/T-RR-058-*.md`) — same "don't touch a different task's own file when the agent's own
 * directory-level scope grant makes it unnecessary" discipline that file's own header already
 * documents ("Deliberately a separate module from `ClaimWorkerModule` ... not a merge into it").
 * Declaring the orchestrator directly in *this* module's own `providers` array needs no change to
 * that file at all — Nest resolves its constructor from whatever this module imports, regardless of
 * which module's `providers` array it is declared in.
 *
 * **Why `ConnectorsModule`/`PromoCodeServiceConnectorModule`/`CoreBankingConnectorModule`/
 * `RedemptionStateMachineModule`/`ObservabilityModule` are imported despite belonging to other
 * agents' own file scope**: importing an already-exported module is normal cross-module
 * consumption, not an edit to any file those agents own (R3) — the identical precedent
 * `redemption-state-machine.module.ts` (importing `agent-rr-foundation`'s `ServiceConfigModule`),
 * `notification.module.ts` (importing this same agent's `ProcessingModule`), and `dispatch.module.ts`
 * (importing `agent-rr-foundation`'s `EncryptionModule`/`ServiceConfigModule`) already establish.
 * The two connector modules are imported specifically so their own `onModuleInit` actually runs and
 * registers `'PROMO_CODE_SERVICE'`/`'CORE_BANKING'` into the *same* `ConnectorRegistry` singleton
 * this module also imports (`ConnectorsModule` is a plain, non-`@Global` module — Nest shares one
 * instance of it across every importer in the same graph, but only if each importer actually lists
 * it) — without this, `ConnectorRegistry.resolve()` would find nothing and every claimed row would
 * fail at the connector-resolution step instead of ever reaching a real connector.
 *
 * **Why this is a legitimate fix location for "AppModule doesn't import this chain" (the defect's
 * own evidence) without ever editing `src/app.module.ts`**: that file (along with `src/main.ts`) is
 * `agent-rr-foundation`'s exclusive file scope (`project.config.json`), confirmed by
 * `src/grpc/grpc-server.main.ts`'s (T-RR-011) and `src/messaging/ingest/kafka-consumer.main.ts`'s
 * (T-RR-012) own headers, both already established for the same reason. `claim-worker.main.ts` (new
 * in this task, same directory) is the same pattern applied here: a self-contained composition root
 * run as its own process, never touching `app.module.ts`. `ConnectorsModule`'s own header
 * (T-RR-030) explicitly names this task's own job as its anticipated follow-up: "wiring
 * `ConnectorsModule` into `AppModule` alongside a real connector's own module is a follow-on concern
 * for ... the task that next wires the pipeline's own resolution step to call through this registry
 * for real."
 *
 * **`CLAIM_WORKER_ENABLED`** (default enabled, read directly from `process.env` — never through
 * `ConfigService`, matching `grpc-server.main.ts`'s/`kafka-consumer.main.ts`'s own
 * `GRPC_SERVER_ENABLED`/`KAFKA_CONSUMER_ENABLED` convention exactly) replaces the previous
 * always-`true` hardcoded value. This is this task's own Rollback lever (`tasks/T-RR-058-*.md`'s own
 * "Rollback" section) — set to `"false"` and restart the standalone claim-worker process to stop it
 * claiming rows at all, without a code change or redeploy of the poll-interval knob itself (still
 * interim-hardcoded, `05-PROCESSING-PIPELINE.md` §3 implementation note 4's own still-unresolved
 * `service_config` keys — unchanged by this task).
 */
import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@/observability/observability.module';
import { ConnectorsModule } from '@/modules/connectors/connectors.module';
import { PromoCodeServiceConnectorModule } from '@/modules/connectors/promo-code-service.connector.module';
import { CoreBankingConnectorModule } from '@/modules/connectors/core-banking.connector.module';
import { RedemptionStateMachineModule } from '@/modules/redemption/redemption-state-machine.module';
import { RewardSystemConfigModule } from '@/modules/reward-system-config/reward-system-config.module';
import { RewardRedemptionEntryClaimRepository } from './reward-redemption-entry-claim.repository';
import { RedemptionProcessingOrchestrator } from './redemption-processing-orchestrator.service';
import { ProcessingModule } from './processing.module';
import {
  CLAIM_WORKER_RUNTIME_CONFIG,
  ClaimWorkerService,
  type ClaimWorkerRuntimeConfig,
} from './claim-worker.service';

export const CLAIM_WORKER_ENABLED_ENV_VAR = 'CLAIM_WORKER_ENABLED';

/**
 * Interim stand-in for `05-PROCESSING-PIPELINE.md` §3 implementation note 4's
 * `claimWorker.pollIntervalMs`/`claimWorker.enabled` `service_config` keys — see this file's own
 * header for why a real `ServiceConfigResolverService` call isn't wired up yet (unchanged by
 * T-RR-058). `enabled` is now read from `CLAIM_WORKER_ENABLED` (this file's own header) rather than
 * hardcoded `true`; `pollIntervalMs` is unchanged.
 *
 * `ClaimWorkerService` depends only on the `ClaimWorkerRuntimeConfig` *interface*
 * (`CLAIM_WORKER_RUNTIME_CONFIG` token) — swapping this `useFactory` provider for one backed by the
 * real resolver, once it exists, is the only change a future task needs to make here.
 */
function resolveInterimRuntimeConfig(): ClaimWorkerRuntimeConfig {
  return {
    pollIntervalMs: 1000,
    enabled: process.env[CLAIM_WORKER_ENABLED_ENV_VAR] !== 'false',
  };
}

@Module({
  imports: [
    ProcessingModule,
    RewardSystemConfigModule,
    ConnectorsModule,
    PromoCodeServiceConnectorModule,
    CoreBankingConnectorModule,
    RedemptionStateMachineModule,
    ObservabilityModule,
  ],
  providers: [
    RewardRedemptionEntryClaimRepository,
    RedemptionProcessingOrchestrator,
    ClaimWorkerService,
    { provide: CLAIM_WORKER_RUNTIME_CONFIG, useFactory: resolveInterimRuntimeConfig },
  ],
  exports: [RewardRedemptionEntryClaimRepository, ClaimWorkerService],
})
export class ClaimWorkerModule {}
