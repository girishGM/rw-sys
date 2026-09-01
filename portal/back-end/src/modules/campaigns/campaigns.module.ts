/**
 * T-037 — DI wiring for `/campaigns`.
 *
 * Follows `merchants.module.ts`/`rules.module.ts` exactly: `RbacModule` brings
 * `ScopedRepository` and the already-global `RolesGuard`/`PermissionsGuard`/
 * `TenancyScopeInterceptor`; `AuditModule` brings `@Audit()`; `DatabaseModule` supplies
 * `SEQUELIZE` for the transactions every write path opens. Nothing here registers a guard,
 * interceptor or filter of its own.
 *
 * `NotificationsModule` is the one addition beyond that pattern — implementation note 13's
 * *"notify checkers"* on submit. `NotificationsService.notify()` is the seam T-040 exported for
 * exactly this purpose (its own header names T-037/T-038 as the intended producers).
 *
 * The five services are exported because **T-038, T-047 and T-048 all consume them**: the
 * approval queue needs the campaign loader and the state machine, the gRPC configuration service
 * needs the assembled journey and the resolved caps, and the AI agent must go through
 * `CampaignsService` rather than reaching the database itself (10-AI-CAMPAIGN-AGENT.md — the
 * agent drafts a plan, a human confirms, and *this* code executes it).
 *
 * `CampaignAuditService` joined that export list in T-038: the checker's approve/reject/return
 * writes `portal_campaign_audit_trail` rows for the *same* campaign, through the same never-fail
 * (`record`) / must-succeed (`recordOrFail`) contract this module already defines. A second
 * writer in the approvals module would be a second place for the `performed_by` gap G1 workaround
 * to be got wrong — see `campaign-audit.service.ts`'s header for what that workaround is.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { ChangeEventsModule } from '@/grpc/change-events.module';
import { PromoCodeServiceModule } from '@/modules/promo-code-integration/promo-code-service.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignAuditService } from './campaign-audit.service';
import { JourneyService } from './journey.service';
import { BindingsService } from './bindings.service';
import { CapsService } from './caps.service';

// T-047 appended `ChangeEventsModule` — the one-provider module holding `ChangeEventPublisher`,
// which `pause`/`resume` announce governance transitions through (09-INTEGRATION.md §9). It is
// deliberately *not* `GrpcModule`: see `change-events.module.ts`'s header for the cycle that would
// create and why the dependency is on "a place to announce a transition" rather than on the gRPC
// server. It registers no guard, interceptor or filter, so its position here carries no meaning.
// T-166 appended `PromoCodeServiceModule` — the one-provider module holding
// `PromoCodeServiceClient`, which `BindingsService.attachReward` registers a maker's chosen Promo
// Code Config through before it writes any local row (04-API-CONTRACT.md §2 in
// `promo-code-service-plan/`). Same shape and same reasoning as `ChangeEventsModule` above: a
// dependency on "somewhere to register a binding", not on an integration subsystem. It registers
// no guard, interceptor or filter, so its position here carries no meaning either.
@Module({
  imports: [
    RbacModule,
    AuditModule,
    DatabaseModule,
    NotificationsModule,
    ChangeEventsModule,
    PromoCodeServiceModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignAuditService, JourneyService, BindingsService, CapsService],
  exports: [CampaignsService, CampaignAuditService, JourneyService, BindingsService, CapsService],
})
export class CampaignsModule {}
