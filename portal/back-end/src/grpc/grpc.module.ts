/**
 * T-047 — DI wiring for the internal configuration service.
 *
 * The lifecycle object that actually opens the socket is `internal-service.bootstrap.ts`; see that
 * file for why the listener is started from a provider rather than from `main.ts`, why it is
 * disabled by default, and why it lives outside this file (this one cannot be imported by a unit
 * test — `AuditModule → DatabaseModule → ConfigModule` validates the environment at import time and
 * calls `process.exit(1)`).
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { CampaignsModule } from '@/modules/campaigns/campaigns.module';
import { GrpcGrantsController } from '@/modules/access-control/grpc-grants.controller';
import { GrpcGrantsService } from '@/modules/access-control/grpc-grants.service';
import { GrpcAccessLog } from './access-log';
import { ServiceRateLimiter } from './rate-limit';
import { ServiceScopeGuard } from './service-scope.guard';
import { ConfigSnapshotBuilder } from './config-snapshot.builder';
import { CampaignConfigService } from './campaign-config.service';
import { CampaignConfigController } from './campaign-config.controller';
import { BudgetBreachController } from './budget-breach.controller';
import { ChangeEventsModule } from './change-events.module';
import { InternalServiceBootstrap } from './internal-service.bootstrap';

@Module({
  imports: [
    // `RbacModule` for `ScopedRepository`, `DatabaseModule` for `SEQUELIZE`, `AuditModule` for the
    // `portal_audit_log` writes the grant surface makes, `CampaignsModule` for the **existing**
    // pause transition the breach callback calls (implementation note 13), and
    // `ChangeEventsModule` for the publisher the watch stream subscribes to.
    //
    // `AuthModule` is here for `GrpcGrantsController` alone, and for the same reason
    // `access-control.module.ts` imports it: that controller re-declares the four session guards at
    // class level (implementation note 14 — *"do not accidentally guard it with the mTLS guard
    // instead of the normal session guards"*), and a class-level `@UseGuards` is instantiated by
    // the declaring module's injector, so `TokenService` and friends must be resolvable from here.
    // Nothing on the internal mTLS surface uses it: that surface authenticates with a certificate
    // and rejects portal credentials outright (`mtls.guard.ts`).
    RbacModule,
    DatabaseModule,
    AuditModule,
    AuthModule,
    CampaignsModule,
    ChangeEventsModule,
  ],
  // `/admin/grpc-grants` (§4d) is an ordinary portal route and is declared here rather than in
  // `AccessControlModule` — see `grpc-grants.controller.ts`'s header (R9).
  controllers: [GrpcGrantsController],
  providers: [
    GrpcGrantsService,
    GrpcAccessLog,
    ServiceRateLimiter,
    ServiceScopeGuard,
    ConfigSnapshotBuilder,
    CampaignConfigService,
    CampaignConfigController,
    BudgetBreachController,
    InternalServiceBootstrap,
  ],
  exports: [GrpcGrantsService, InternalServiceBootstrap],
})
export class GrpcModule {}
