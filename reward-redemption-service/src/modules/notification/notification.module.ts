/**
 * T-RR-036. Wires this task's own three providers (`NotificationLogRepository`,
 * `NotificationMetricsService`, `NotificationService`) plus the `NOTIFICATION_ENABLED_RESOLVER`
 * binding (`notification.service.ts`'s own header explains the design gap that binding papers
 * over). Imports `ProcessingModule` (T-RR-022, done, `agent-rr-processing`'s own file) for
 * `CampaignConfigCache` rather than reaching into `src/modules/processing/**` directly — normal
 * cross-module consumption of an already-exported provider, not an edit to any file that module's
 * owning agent owns (R3).
 *
 * **Not wired into `AppModule` by this task**, and `RedemptionStateMachineModule`'s own
 * `REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT` binding is still the
 * `NotImplementedRedemptionCompletionSideEffects` stub (`redemption-completion-side-effects.
 * port.ts`'s own header, confirmed by direct read) — nothing in the real pipeline calls
 * `NotificationService.notifyIfConfigured()` yet. `dispatch.module.ts`'s own header (T-RR-034)
 * already names this exact gap for the outbox leg; the identical gap applies here: composing a
 * real `RedemptionCompletionSideEffectsPort` implementation on top of this module's own exports
 * (and `DispatchModule`'s) is a distinct, not-yet-filed unit of work belonging to whichever task
 * next wires `RedemptionStateMachineModule` into `AppModule` for real use — that module is
 * `src/modules/redemption/**`, outside this task's own file scope (R3). Flagged for the architect
 * in this task's own completion report rather than worked around here.
 */
import { Module } from '@nestjs/common';
import { ProcessingModule } from '@/modules/processing/processing.module';
import { NotificationLogRepository } from './notification-log.repository';
import { NotificationMetricsService } from './notification-metrics.service';
import {
  NO_NOTIFICATION_FLAG_YET_RESOLVER,
  NOTIFICATION_ENABLED_RESOLVER,
  NotificationService,
} from './notification.service';

@Module({
  imports: [ProcessingModule],
  providers: [
    NotificationLogRepository,
    NotificationMetricsService,
    { provide: NOTIFICATION_ENABLED_RESOLVER, useValue: NO_NOTIFICATION_FLAG_YET_RESOLVER },
    NotificationService,
  ],
  exports: [NotificationLogRepository, NotificationMetricsService, NotificationService],
})
export class NotificationModule {}
