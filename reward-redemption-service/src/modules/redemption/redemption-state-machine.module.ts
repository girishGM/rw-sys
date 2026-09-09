import { Module } from '@nestjs/common';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { DispatchModule } from '@/modules/dispatch/dispatch.module';
import { NotificationModule } from '@/modules/notification/notification.module';
import { RedemptionStateMachineService } from './redemption-state-machine.service';
import { CompletionSweepService } from './completion-sweep.service';
import {
  RedemptionCompletionSideEffects,
  REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT,
} from './redemption-completion-side-effects.port';

/**
 * T-RR-021. Wires `RedemptionStateMachineService` and `CompletionSweepService` — the single place
 * every `reward_redemption_entry.status` transition is written, plus the periodic recovery sweep
 * for a row stuck in `dispatched_external`.
 *
 * Imports `ServiceConfigModule` (T-RR-006, done) rather than reaching into
 * `src/modules/service-config/**` directly — that directory is `agent-rr-foundation`'s own file
 * scope (R3); importing its already-exported `ServiceConfigModule`/`ServiceConfigResolverService`
 * is normal cross-module consumption, not an edit to any file it owns.
 *
 * Also imports `ObservabilityModule` (T-RR-040, `agent-rr-qa`'s own file scope, same "import the
 * already-exported module" convention) so `CompletionSweepService` can be given a real
 * `MetricsRegistry` for its own `reward_redemptions_completed_total` increment (T-RR-057).
 *
 * **T-RR-061 update (2026-09-06).** `REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT` is now bound to
 * `RedemptionCompletionSideEffects` — the real implementation
 * (`redemption-completion-side-effects.port.ts`'s own header) that drives
 * `05-PROCESSING-PIPELINE.md` §6 steps 3-4 for real, closing the gap left by the previous
 * `NotImplementedRedemptionCompletionSideEffects` stub binding. This needs `DispatchModule`
 * (T-RR-034, `DispatchChannelResolverService`/`RewardTrackingOutboxRepository`) and
 * `NotificationModule` (T-RR-036, `NotificationService`) imported alongside `ServiceConfigModule`/
 * `ObservabilityModule` above — same "import the already-exported module, don't reach into its
 * files" cross-module consumption convention this header already establishes for those two.
 *
 * **Not wired into `AppModule` by this task** — same convention `ClaimWorkerModule` (T-RR-020) and
 * `ServiceConfigModule` (T-RR-006) already documented: `AppModule` isn't in this task's own "Files
 * owned" list (R3). `ClaimWorkerModule` (T-RR-058) is the real caller in the running app, importing
 * this module directly.
 */
@Module({
  imports: [ServiceConfigModule, ObservabilityModule, DispatchModule, NotificationModule],
  providers: [
    RedemptionStateMachineService,
    CompletionSweepService,
    {
      provide: REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT,
      useClass: RedemptionCompletionSideEffects,
    },
  ],
  exports: [RedemptionStateMachineService, CompletionSweepService],
})
export class RedemptionStateMachineModule {}
