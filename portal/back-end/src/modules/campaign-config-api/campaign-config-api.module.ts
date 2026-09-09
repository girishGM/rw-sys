/**
 * T-INT-010 — DI wiring for the REST mirror of `CampaignConfigService`.
 *
 * `CampaignConfigService` and its three collaborators (`ServiceScopeGuard`,
 * `ConfigSnapshotBuilder`, `ServiceRateLimiter`) are declared as providers **of this module**
 * rather than imported from `GrpcModule`, which does not export them (only `GrpcGrantsService`
 * and `InternalServiceBootstrap` are). Two ways to get a shared instance were available: export
 * them from `GrpcModule` (a one-line, additive change to a file outside this task's "Files
 * owned"), or re-provide the same, unmodified classes here, taking a second DI-container
 * instance. The second is what this file does — it costs nothing this task's TCs care about
 * (`CampaignConfigService` and `ConfigSnapshotBuilder` are stateless; `ServiceRateLimiter`'s
 * in-memory window becomes per-transport rather than shared across gRPC+REST, noted as a
 * follow-up in the completion report) and it stays entirely inside this task's own file scope.
 * `GrpcGrantsService` itself is **not** re-provided: `GrpcModule` already exports it as a
 * singleton, and importing that module here reuses the exact same grants table reader gRPC uses
 * — the "one authorisation table, two transports" property implementation note 2 relies on.
 */
import { Module } from '@nestjs/common';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { GrpcModule } from '@/grpc/grpc.module';
import { ChangeEventsModule } from '@/grpc/change-events.module';
import { ServiceScopeGuard } from '@/grpc/service-scope.guard';
import { ConfigSnapshotBuilder } from '@/grpc/config-snapshot.builder';
import { CampaignConfigService } from '@/grpc/campaign-config.service';
import { ServiceRateLimiter } from '@/grpc/rate-limit';
import { CampaignConfigApiController } from './campaign-config-api.controller';
import { ServiceApiAuthGuard } from './service-api-auth.guard';

@Module({
  imports: [
    RbacModule, // ScopedRepository (CampaignConfigService, ConfigSnapshotBuilder)
    DatabaseModule, // SEQUELIZE
    ChangeEventsModule, // ChangeEventPublisher
    GrpcModule, // GrpcGrantsService (exported) — the one grants table, shared with gRPC
  ],
  controllers: [CampaignConfigApiController],
  providers: [
    ServiceScopeGuard,
    ConfigSnapshotBuilder,
    CampaignConfigService,
    ServiceRateLimiter,
    ServiceApiAuthGuard,
  ],
})
export class CampaignConfigApiModule {}
