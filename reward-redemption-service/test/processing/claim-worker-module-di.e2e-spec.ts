/**
 * T-RR-058 — regression test for the second half of the defect this task fixes: even once
 * `ClaimWorkerService` actually calls `RedemptionProcessingOrchestrator`, nothing wired the module
 * tree together so `RedemptionProcessingOrchestrator` (and its own five constructor dependencies)
 * could ever be resolved by real Nest DI in the same graph as `ClaimWorkerService` — the defect's
 * own evidence ("`ClaimWorkerModule` does not provide or import `RedemptionProcessingOrchestrator`,
 * `RedemptionStateMachineService`, `ConnectorRegistry`, or any of their dependency modules").
 *
 * Compiles `ClaimWorkerRootModule` — the *exact* root module `claim-worker.main.ts`'s own real
 * process bootstraps (not a hand-assembled stand-in) — via `Test.createTestingModule(...).compile()`,
 * same "construct the real module graph, not a copy of it" precedent
 * `processing-module-di.e2e-spec.ts` (T-RR-055) already established for `ProcessingModule`.
 *
 * **Deliberately never calls `.init()`** on the compiled module (no `createNestApplication()` +
 * `app.init()`, no `NestFactory.createApplicationContext()`) — `claim-worker.main.ts`'s own header
 * explains why in full: `RedemptionStateMachineModule`'s own `CompletionSweepService` starts a real,
 * unscoped sweep loop against the shared `reward_redemption_entry` table from its own
 * `onApplicationBootstrap`, unconditionally, the moment any lifecycle-complete Nest context
 * containing it exists — and `.compile()` alone never calls `onModuleInit`/`onApplicationBootstrap`
 * (confirmed by direct read, `@nestjs/testing/testing-module.builder.js`), so this test proves the
 * DI graph is valid without that hazard.
 */
import { Test } from '@nestjs/testing';
import { ClaimWorkerRootModule } from '@/modules/processing/claim-worker.main';
import { ClaimWorkerService } from '@/modules/processing/claim-worker.service';
import { RedemptionProcessingOrchestrator } from '@/modules/processing/redemption-processing-orchestrator.service';
import { RewardRedemptionEntryClaimRepository } from '@/modules/processing/reward-redemption-entry-claim.repository';
import { TenantSchemaEnrichmentService } from '@/modules/processing/reward-system-resolution.service';
import { ConnectorRegistry } from '@/modules/connectors/connector-registry';
import { RedemptionStateMachineService } from '@/modules/redemption/redemption-state-machine.service';

describe('T-RR-058 — ClaimWorkerRootModule (the real claim-worker.main.ts composition root) compiles via real Nest DI', () => {
  it('TC-2/TC-3: resolves ClaimWorkerService, RedemptionProcessingOrchestrator, and every dependency the defect named', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClaimWorkerRootModule],
    }).compile();

    try {
      const orchestrator = moduleRef.get(RedemptionProcessingOrchestrator);
      expect(orchestrator).toBeInstanceOf(RedemptionProcessingOrchestrator);
      expect(moduleRef.get(ClaimWorkerService)).toBeInstanceOf(ClaimWorkerService);
      // The defect's own evidence named these three as unresolvable in the real graph —
      // proving each one is a real, DI-resolved singleton (not just present in the source tree)
      // is exactly what closes that evidence.
      expect(moduleRef.get(RedemptionStateMachineService)).toBeInstanceOf(
        RedemptionStateMachineService,
      );
      expect(moduleRef.get(ConnectorRegistry)).toBeInstanceOf(ConnectorRegistry);
      expect(moduleRef.get(RewardRedemptionEntryClaimRepository)).toBeInstanceOf(
        RewardRedemptionEntryClaimRepository,
      );
      // T-RR-065: `RedemptionProcessingOrchestrator`'s seventh (optional) constructor dependency —
      // proves the real `ClaimWorkerRootModule` graph actually supplies a real instance (via
      // `ProcessingModule`, already imported here for the orchestrator's other dependencies), not
      // just that the orchestrator happens to compile without one.
      expect(moduleRef.get(TenantSchemaEnrichmentService)).toBeInstanceOf(
        TenantSchemaEnrichmentService,
      );
    } finally {
      // Real `pg.Pool`/DB-backed providers were constructed above (never connected to, `.compile()`
      // never issues I/O — same reasoning `processing-module-di.e2e-spec.ts` already documents for
      // its own gRPC client) — closing releases them rather than leaking an open handle into the
      // rest of the Jest run.
      await moduleRef.close();
    }
  });
});
