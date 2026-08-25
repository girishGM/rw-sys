/**
 * T-038 — DI wiring for `/approvals`.
 *
 * Follows `campaigns.module.ts` (T-037) exactly: `RbacModule` brings `ScopedRepository` and the
 * already-global `RolesGuard`/`PermissionsGuard`/`TenancyScopeInterceptor`; `AuditModule` brings
 * `@Audit()`; `DatabaseModule` supplies `SEQUELIZE` for the one transaction every decision opens;
 * `NotificationsModule` supplies the `notify()` seam the maker's notification uses. Nothing here
 * registers a guard, interceptor or filter of its own.
 *
 * ### `CampaignsModule`, and what this module deliberately does *not* import from it
 *
 * `CampaignAuditService` only. The campaign lifecycle is consumed as two **pure functions**
 * (`assertTransition`, `actorRefText`) imported directly from their files rather than through a
 * service, because they hold no state and touch no database — importing a service to reach a
 * lookup table would make the dependency look bigger than it is.
 *
 * What this module very deliberately does not do is re-implement campaign authoring. A checker
 * approves or refuses what a maker built; it never edits it. That is why `JourneyService`,
 * `BindingsService` and `CapsService` are absent from this list even though `CampaignsModule`
 * exports all three.
 *
 * ### `ScheduleModule.forRoot()`
 *
 * This is the first task in the project to need a scheduled job (implementation note 5's expiry
 * sweep), so `@nestjs/schedule` — a declared dependency since T-001, unused until now — is
 * initialised here rather than in `app.module.ts`. `forRoot()` is idempotent from Nest's point of
 * view (identical dynamic-module metadata resolves to one instance), so a later task that needs a
 * cron of its own can call it in its own module without conflict, and this module keeps its
 * scheduling concern next to the job it schedules.
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { CampaignsModule } from '@/modules/campaigns/campaigns.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { ChangeEventsModule } from '@/grpc/change-events.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { ApprovalExpirySweeper } from './approval-expiry.sweeper';
import { APPROVAL_EXPIRY_STORE, ApprovalsRepository } from './approvals.repository';

@Module({
  imports: [
    RbacModule,
    AuditModule,
    DatabaseModule,
    NotificationsModule,
    CampaignsModule,
    // T-047 appended `ChangeEventsModule` — approval is the transition 09-INTEGRATION.md §9 calls
    // `UPDATED`, and this is the module that carries the publisher. Same one-provider module
    // `CampaignsModule` imports, so both producers announce through one instance.
    ChangeEventsModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [ApprovalsController],
  providers: [
    ApprovalsService,
    ApprovalExpirySweeper,
    ApprovalsRepository,
    { provide: APPROVAL_EXPIRY_STORE, useExisting: ApprovalsRepository },
  ],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
