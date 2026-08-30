import { Module } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { HealthModule } from '@/modules/health/health.module';
import { DatabaseModule } from '@/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { SecurityModule } from '@/common/security/security.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { AuditModule } from '@/common/audit/audit.module';
import { ErrorsModule } from '@/common/errors/errors.module';
import { MeModule } from '@/modules/me/me.module';
import { DataProtectionModule } from '@/common/data-protection/data-protection.module';
import { TransportCryptoModule } from '@/common/transport-crypto/transport-crypto.module';
import { LoggerModule } from '@/common/logging/logger.module';
import { TracingModule } from '@/common/tracing/tracing.module';
import { TraceModule } from '@/modules/trace/trace.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { AuditViewerModule } from '@/modules/audit/audit-viewer.module';
import { CountriesModule } from '@/modules/countries/countries.module';
import { RulesModule } from '@/modules/rules/rules.module';
import { RewardsModule } from '@/modules/rewards/rewards.module';
import { AccessControlModule } from '@/modules/access-control/access-control.module';
import { TenantsModule } from '@/modules/tenants/tenants.module';
import { VersionsModule } from '@/modules/versions/versions.module';
import { BlastsModule } from '@/modules/blasts/blasts.module';
import { UsersModule } from '@/modules/users/users.module';
import { MerchantsModule } from '@/modules/merchants/merchants.module';
import { CampaignsModule } from '@/modules/campaigns/campaigns.module';
import { DefinitionRequestsModule } from '@/modules/definition-requests/definition-requests.module';
import { MerchantPortalModule } from '@/modules/merchant-portal/merchant-portal.module';
import { ApprovalsModule } from '@/modules/approvals/approvals.module';
import { GrpcModule } from '@/grpc/grpc.module';
import { CampaignAgentModule } from '@/modules/campaign-agent/agent.module';
import { DashboardModule } from '@/modules/dashboard/dashboard.module';
import { FieldValueSourcesModule } from '@/modules/field-value-sources/field-value-sources.module';

/**
 * Append-only registration point (05-EXECUTION-PLAN.md §3): each task adds its own module
 * import line here and touches nothing else in this file, so two agents working in
 * parallel never collide on this file's content.
 *
 * The security chain (00-ARCHITECTURE.md §6) — helmet, CORS, rate limiting, CSRF,
 * JwtAuthGuard, SessionValidGuard, RolesGuard, PermissionsGuard, TenancyScopeInterceptor,
 * AuditInterceptor, ErrorNormalisationFilter — is composed by later tasks (T-012, T-013,
 * T-014) in the fixed order that document specifies. Nothing here yet, since T-001 is
 * skeleton-only.
 */
@Module({
  // T-011 appended AuthModule — it brings `/auth/*` and the three session guards. It does NOT
  // register those guards globally: T-013 owns composing the global chain in §6's fixed order,
  // and doing it here would 401 `GET /health`, whose controller this task does not own and
  // therefore cannot annotate `@Public()`. See auth.controller.ts's header.
  // T-012 appended SecurityModule. It registers `RateLimitGuard` and `CsrfGuard` as global
  // guards (00-ARCHITECTURE.md §6, positions 3 and 4) — unlike T-011's three, neither of them
  // denies an anonymous request, so global registration does not break `GET /health`. It is
  // listed after AuthModule because it depends on `TokenService`; Nest resolves the graph
  // regardless of order here, and the placement is for the reader. The header/CORS/body-limit
  // half of this task is not a module at all: `main.ts` calls `configureHttpSecurity`.
  // T-013 appended RbacModule. It completes the §6 chain — `JwtAuthGuard` (5),
  // `SessionValidGuard` (6), `PasswordChangeRequiredGuard` (6b), `RolesGuard` (7),
  // `PermissionsGuard` (8) as global guards, and `TenancyScopeInterceptor` (9) via the
  // `ScopeModule` it re-exports. **Its position in this array is load-bearing:** Nest registers
  // global providers in module-resolution order, so it must come *after* `SecurityModule`
  // (positions 3 and 4) for the composed order to be the one §6 fixes. Do not move it.
  //
  // From this point on every route is authenticated and authorisation-checked unless it carries
  // `@Public()` — which is why `HealthController` gained that decorator in the same change
  // (T-001's own file comment delegated it to this task).
  // T-014 appended AuditModule and ErrorsModule — positions 11 and 12, the last two links of the
  // §6 chain. `AuditModule` registers `AuditInterceptor` as a global interceptor and **must stay
  // after `RbacModule`**, which re-exports the `ScopeModule` that registers
  // `TenancyScopeInterceptor` (position 9): Nest orders global interceptors by module-resolution
  // order, so an earlier position here would run the audit write outside the tenancy scope
  // context. `ErrorsModule` registers the global `APP_FILTER`; a filter's position in this array
  // does not affect behaviour (there is exactly one, and it catches everything), but it is
  // listed last to match the document.
  // T-015 appended MeModule — `/me/bootstrap`, `/me` and `PATCH /me`. It registers no global
  // provider of its own, so unlike `RbacModule` its position in this array carries no meaning for
  // the §6 chain; it is listed last because it is a feature module rather than a link in that
  // chain, and it must come after `RbacModule`, whose exports (`PermissionCacheService`,
  // `PERMISSION_STORE`, and the re-exported `ScopeModule`) it consumes.
  // T-017 appended DataProtectionModule — the policy engine, `GET /reveal/:policyKey/:recordId`,
  // and the global `ResponseMaskingInterceptor`. **Its position is load-bearing, in the opposite
  // direction to `RbacModule`'s:** Nest runs interceptors' *response*-side logic in reverse
  // registration order, and this interceptor does response-side work only, so a module listed
  // EARLIER in this array wraps its output. 07-DATA-PROTECTION.md §8 fixes the order as
  // `DTO → mask → serialise → encrypt`, so **T-018 must register its payload-encryption
  // interceptor before this line**, not after — otherwise the envelope is built from the unmasked
  // body and nothing visibly fails. See `data-protection.module.ts`'s header.
  // T-018 appended TransportCryptoModule — `PayloadDecryptInterceptor` and
  // `PayloadEncryptInterceptor`. **It is listed immediately BEFORE `DataProtectionModule`, and
  // that position is the whole of T-017's warning above discharged.** Nest runs response-side
  // interceptor logic in reverse registration order, so an earlier entry here wraps a later one's
  // output: listed here, the encrypt interceptor runs *after* `ResponseMaskingInterceptor` and
  // 07-DATA-PROTECTION.md §8's fixed order `DTO → mask → serialise → encrypt` holds. Moving this
  // line after `DataProtectionModule` would build the envelope from the unmasked body, and
  // nothing would visibly fail — T-018 TC-17 is the test that catches it.
  //
  // Nest inserts a module into its container before recursing into that module's own imports, so
  // `TransportCryptoModule` importing `DataProtectionModule` does not hoist the latter ahead of
  // it. `transport-crypto.e2e-spec.ts` asserts the resulting order for real rather than trusting
  // that reading.
  // T-019 appended LoggerModule and TracingModule, and **they are first in this array on
  // purpose** — two separate reasons, neither of which is style:
  //
  //  1. `LoggerModule` is what `main.ts`'s `app.useLogger(...)` redirects every `new Logger(X)`
  //     in the codebase into. Registering it first means the JSON envelope, the correlation id
  //     and the T-017 masking pipeline are in force for the earliest line any other module can
  //     write, rather than for whatever is logged after some arbitrary point in the graph.
  //  2. Nest applies middleware in module-registration order, and `TracingModule` contributes
  //     `CorrelationMiddleware` — the component that establishes the `AsyncLocalStorage` trace
  //     every log line, every SQL comment and every audit row's `correlation_id` reads. A module
  //     registered before it would produce records with no correlation id at all.
  //
  // **Neither registers a global guard, interceptor or filter**, which is what makes putting them
  // first safe: the §6 chain order and 07-DATA-PROTECTION.md §8's `DTO → mask → serialise →
  // encrypt` are both decided by `APP_INTERCEPTOR` registration order, and these two contribute
  // none. `TracingModule` imports only `DatabaseModule` (for the SQL-comment wrapper) and
  // `LoggerModule` only `ConfigModule`, so neither drags a global-provider module forward with
  // it either — that hoisting hazard is why the log-masking policy lookup is late-bound rather
  // than injected. See `tracing/logger.config.ts` for the full argument.
  //
  // T-045 appended TraceModule — `GET /audit/trace/:correlationId`. It registers no global
  // guard, interceptor or filter of its own (its route is protected entirely by the already-
  // global `RolesGuard`/`ResponseMaskingInterceptor` chain the modules above establish), so
  // unlike `TransportCryptoModule`/`DataProtectionModule` its position here carries no ordering
  // meaning — it is listed last, after `RbacModule` (for `ScopedRepository`) and `AuditModule`
  // (for `@Audit`), both of which it imports.
  // T-030 appended CountriesModule — `/countries`, the first Wave 3 feature module. Like
  // `TraceModule`, it registers no global guard, interceptor or filter (its routes rely
  // entirely on the already-global RBAC/scope/audit chain), so its position here carries no
  // ordering meaning; listed after `RbacModule`/`AuthModule`/`AuditModule`/`DatabaseModule`,
  // all of which it imports.
  // T-040 appended NotificationsModule (`/notifications`) and AuditViewerModule
  // (`/audit/campaigns`, `/audit/portal`). Same shape as `TraceModule`/`CountriesModule`:
  // neither registers a global guard, interceptor or filter, so their position here carries no
  // ordering meaning; both are listed after `RbacModule` (`ScopedRepository`,
  // `Roles`/`RequirePermission`) and `AuditModule` (`@Audit()`), which `AuditViewerModule`
  // imports directly and `NotificationsModule` reaches transitively through `RbacModule`.
  // T-031 appended RulesModule (`/rules`, `/rule-categories`, `/rule-sub-categories`). Same
  // shape again: no global guard/interceptor/filter of its own, so its position carries no
  // ordering meaning; listed after `RbacModule`/`AuditModule`/`DatabaseModule`, all of which
  // it imports.
  // T-032 appended RewardsModule (`/rewards`). Same shape once more, plus `CryptoModule`
  // (T-016, for `connector_config` field encryption — `rewards.module.ts`'s own header); no
  // global guard/interceptor/filter of its own, so its position carries no ordering meaning.
  // T-033 appended AccessControlModule (`/admin/access-control`). No global guard/interceptor/
  // filter of its own — the four guards its controller duplicates at class level
  // (`access-control.controller.ts`'s own header explains why) are `@UseGuards`-scoped to that
  // controller, not registered as `APP_GUARD`s here, so this line's position carries no ordering
  // meaning; listed after `RbacModule`/`AuditModule`/`DatabaseModule`/`AuthModule`, all of which
  // it imports. Note for whoever picks up T-055's `MfaAdminController`
  // (`back-end/src/modules/auth/mfa-admin.controller.ts`): that file already registers
  // `POST /admin/access-control/super-admins/:id/mfa-reset` under the same path prefix, in
  // `AuthModule`, which is imported above this line already — this task did not re-declare it.
  // T-034 appended TenantsModule (`/tenants`) — the second link in the delegation chain after
  // `CountriesModule`. Same shape once more: no global guard/interceptor/filter of its own, so
  // its position here carries no ordering meaning; listed after `RbacModule`/`AuthModule`/
  // `AuditModule`/`DatabaseModule` (for `ScopedRepository`, `CredentialService`/`SessionService`,
  // `@Audit()` and `SEQUELIZE` respectively) and after `CountriesModule`, matching the
  // dependency order 05-EXECUTION-PLAN.md §4 gives Wave 3's critical path.
  // T-035 appended UsersModule (`/users`) — the third link in the delegation chain, after
  // `TenantsModule`. Same shape once more: no global guard/interceptor/filter of its own, so its
  // position here carries no ordering meaning; listed after `RbacModule`/`AuthModule`/
  // `AuditModule`/`DatabaseModule` (for the same four reasons `TenantsModule`'s own comment
  // gives) and after `TenantsModule`, matching 05-EXECUTION-PLAN.md §4's dependency order.
  // T-041 appended VersionsModule (`/rules/:id/versions`, `/rewards/:id/versions`,
  // `/countries/:id/assigned-versions`) and BlastsModule (`/blasts`). Same shape again: neither
  // registers a global guard/interceptor/filter of its own, so their position here carries no
  // ordering meaning; listed after `RulesModule`/`RewardsModule` (both depended on, per this
  // task's own `Depends on`) and after `CountriesModule`/`NotificationsModule`, which
  // `BlastsModule` imports directly (`ScopedRepository`'s `Country`/`PortalUser` reads and
  // `NotificationsService.notify()` respectively).
  // T-036 appended MerchantsModule (`/merchants`) — the fourth link in the delegation chain,
  // after `UsersModule` (05-EXECUTION-PLAN.md §4: T-034 → T-035 → T-036). Same shape once more:
  // no global guard/interceptor/filter of its own, so its position here carries no ordering
  // meaning; listed after `RbacModule`/`AuthModule`/`AuditModule`/`DatabaseModule` (for
  // `ScopedRepository`, `SessionService`, `@Audit()` and `SEQUELIZE` respectively) and after
  // `UsersModule`, matching 05-EXECUTION-PLAN.md §4's dependency order.
  // T-042 appended DefinitionRequestsModule (`/definition-requests`). Same shape once more: no
  // global guard/interceptor/filter of its own, so its position here carries no ordering
  // meaning; listed after `RbacModule`/`AuditModule`/`NotificationsModule` (for `ScopedRepository`,
  // `@Audit()` and `NotificationsService.notify()` respectively) and after `VersionsModule`/
  // `BlastsModule`, matching this task's own `Depends on` (T-041).
  // T-037 appended CampaignsModule (`/campaigns`) — the fifth link in the delegation chain, after
  // `MerchantsModule` (05-EXECUTION-PLAN.md §4: T-034 → T-035 → T-036 → T-037). Same shape once
  // more: no global guard/interceptor/filter of its own, so its position here carries no ordering
  // meaning; listed after `RbacModule`/`AuditModule`/`DatabaseModule` (for `ScopedRepository`,
  // `@Audit()` and `SEQUELIZE`) and after `NotificationsModule`, whose `notify()` seam the submit
  // path calls to alert the tenant's checkers (implementation note 13).
  // T-038 appended ApprovalsModule (`/approvals`) — the checker half of the maker/checker pair
  // `CampaignsModule` opens, and therefore listed immediately after it (05-EXECUTION-PLAN.md §4:
  // T-037 → T-038). It imports `CampaignsModule` directly, for `CampaignAuditService`.
  //
  // **It is the first module in the project to register a scheduled job** (`ScheduleModule.forRoot()`
  // inside `approvals.module.ts`, for the expiry sweep). That contributes no global guard,
  // interceptor or filter — `SchedulerOrchestrator` is a lifecycle hook, not part of the §6 chain
  // — so this line's position still carries no ordering meaning, and the composed guard order is
  // unchanged.
  // T-039 appended MerchantPortalModule (`/merchant/campaigns`, `/merchant/summary`) — the
  // merchant role's own read-only surface (`Depends on: T-036, T-037`). It imports only
  // `RbacModule` (for `ScopedRepository`), so like every feature module above its position here
  // carries no ordering meaning; listed after `MerchantsModule`/`CampaignsModule`, matching this
  // task's own `Depends on`.
  // T-047 appended GrpcModule — the internal mTLS configuration service (port 50051) plus the two
  // surfaces that hang off it: `/admin/grpc-grants` (§4d), which is an ordinary `super_admin` REST
  // route on *this* app, and the budget-breach callback (§7a), which is deliberately **not** —
  // it lives on the internal listener, in a different trust domain, and is unreachable from
  // `/api/v1` by construction. The listener itself is off unless `GRPC_ENABLED=true`, so this line
  // opens no port in any environment that has not been given certificates. Like every feature
  // module above it registers no global guard, interceptor or filter, so its position here carries
  // no ordering meaning; it is listed after `CampaignsModule`, whose **existing** pause transition
  // the breach callback calls (implementation note 13) rather than writing a status of its own.
  // T-048 appended CampaignAgentModule (`/campaign-agent`) — the conversational path to the same
  // campaign the wizard builds (10-AI-CAMPAIGN-AGENT.md). It imports `CampaignsModule` directly and
  // is listed after it for that reason: §2's Zone 3 is *"the SAME calls a human maker makes"*, so
  // every write it performs goes through `CampaignsService`/`JourneyService`/`BindingsService`/
  // `CapsService` rather than through the database. Like every feature module above it registers no
  // global guard, interceptor or filter, so its position here carries no ordering meaning. It opens
  // no port and reaches no network by default: the model is local Ollama on loopback (§8), and the
  // route degrades to a 503 with a wizard link when it is not running (§9), which is also this
  // task's documented rollback.
  // T-092 appended DashboardModule (`/dashboard/widgets/:widgetKey`) — the defect fix this task
  // exists for: the route `front-end/src/features/dashboard/widgets/api.ts` has called since
  // T-023 with nothing behind it (`dashboard.module.ts`'s own header). No global guard,
  // interceptor or filter of its own, so its position here carries no ordering meaning; listed
  // last, after `TenantsModule`/`MerchantPortalModule`, both of which it imports directly for the
  // two services it deliberately reuses rather than re-derives (`dashboard.service.ts`'s own
  // header).
  // T-121 appended FieldValueSourcesModule (`/field-context-providers`,
  // `/field-api-lookup-providers`) — the two pluggable value-source registries
  // (13-REWARD-MASTER-VALUE-SOURCES.md §3). Registers no global guard, interceptor or filter, so
  // its position here carries no ordering meaning; listed last, appended per 05-EXECUTION-PLAN.md
  // §3.
  imports: [
    LoggerModule,
    TracingModule,
    ConfigModule,
    HealthModule,
    DatabaseModule,
    AuthModule,
    SecurityModule,
    RbacModule,
    AuditModule,
    ErrorsModule,
    MeModule,
    TransportCryptoModule,
    DataProtectionModule,
    TraceModule,
    CountriesModule,
    NotificationsModule,
    AuditViewerModule,
    RulesModule,
    RewardsModule,
    AccessControlModule,
    TenantsModule,
    UsersModule,
    VersionsModule,
    BlastsModule,
    MerchantsModule,
    DefinitionRequestsModule,
    CampaignsModule,
    ApprovalsModule,
    MerchantPortalModule,
    GrpcModule,
    CampaignAgentModule,
    DashboardModule,
    FieldValueSourcesModule,
  ],
})
export class AppModule {}
