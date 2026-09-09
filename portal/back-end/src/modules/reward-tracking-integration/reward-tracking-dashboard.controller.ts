/**
 * T-INT-030 implementation note 5 — the portal-native REST surface T-INT-031's own front-end
 * dashboard calls: `/api/v1/dashboard/reward-tracking/...`, matching `dashboard.controller.ts`'s
 * (T-092) own `/api/v1/dashboard/...` naming convention (checked directly before picking this
 * path, per this task's own implementation note).
 *
 * Thin by design — the same shape `dashboard.controller.ts`/`campaign-config-api.controller.ts`
 * establish: read the already-authenticated caller (`@CurrentUser()` — the portal's existing
 * `JwtAuthGuard`/`RolesGuard` chain runs unchanged, ahead of this controller, exactly as it does
 * for every other route; this class adds no guard of its own, only `@Roles(...)`, mirroring
 * `dashboard.controller.ts`'s own reasoning: "everyone may reach this route" still has to be said
 * explicitly, since `RolesGuard` denies a route with no authorisation metadata at all), mint this
 * leg's own narrower RTS credential from that same verified scope, resolve the transport, call
 * RTS, return what it said.
 *
 * **No wider than RTS's own guard already allows** (implementation note 5's own warning): the
 * claims minted below are copied verbatim from the *already-verified* portal session
 * (`AuthenticatedUser` — R3, `current-user.decorator.ts`'s own rule: `tenantId`/`countryId`/
 * `merchantId`/`role` never come from a request param), never widened, and every RTS rejection
 * (400/401/403/404) is forwarded as the same status, not translated into a broader "not found" or
 * swallowed into a 500 (`reward-tracking-rest.client.ts`'s own `RewardTrackingUpstreamRejectionError`
 * — `ErrorNormalizationFilter` renders it through the portal's usual envelope, same as every other
 * `AppError`).
 *
 * ### Why there is no automatic REST→gRPC failover here (a deliberate simplification, disclosed)
 *
 * `ARCHITECTURE.md` finding 6 describes RR's own multi-tier fallback (Kafka → gRPC → retry table)
 * for a leg where every tier is a real, working transport. This leg has exactly one working
 * transport (REST) — RTS's gRPC surface is ingest-only (finding 8; implementation note 4).
 * Automatically "falling back" to gRPC would either mask a genuine REST outage behind a
 * guaranteed-to-fail attempt, or — what TC-6 specifically tests against — silently reroute a
 * deliberately-`GRPC`-primary configuration back through REST, defeating the entire point of
 * `set-transport-primary.js` (proving a transport switch actually took effect). So: when the
 * resolved primary channel is `GRPC`, this controller fails closed immediately with
 * {@link RewardTrackingGrpcNotAvailableError}, with no fallback attempt — a clear, single error,
 * never a silent reroute, a hang, or a crash.
 */
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { RewardTrackingAdminTokenService } from './reward-tracking-admin-token';
import {
  RewardTrackingChannelResolverService,
  type RewardTrackingChannelResolveContext,
} from './reward-tracking-channel-resolver.service';
import {
  RewardTrackingRestClient,
  RewardTrackingGrpcNotAvailableError,
  RewardTrackingServiceUnavailableError,
  type RewardTrackingProxyResponse,
} from './reward-tracking-rest.client';

@Controller('dashboard/reward-tracking')
export class RewardTrackingDashboardController {
  constructor(
    private readonly tokens: RewardTrackingAdminTokenService,
    private readonly resolver: RewardTrackingChannelResolverService,
    private readonly client: RewardTrackingRestClient,
  ) {}

  /** RTS doc §2.1 via `admin-rewards.controller.ts#getCampaignSummary`. No numeric `tenantId` is
   * even in this route's own path — RTS resolves it itself from `campaign_hierarchy_cache`; the
   * claim's `tenantId` still travels in the minted token for RTS's own verification. */
  @Get('campaigns/:campaignCode/summary')
  @Roles(...ALL_PORTAL_ROLES)
  async getCampaignSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('campaignCode') campaignCode: string,
  ): Promise<RewardTrackingProxyResponse> {
    return this.proxy({ campaignCode, tenantId: actor.tenantId ?? undefined }, actor, (token) =>
      this.client.getCampaignSummary(campaignCode, token),
    );
  }

  @Get('merchants/:merchantCode/summary')
  @Roles(...ALL_PORTAL_ROLES)
  async getMerchantSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('merchantCode') merchantCode: string,
  ): Promise<RewardTrackingProxyResponse> {
    return this.proxy({ tenantId: actor.tenantId ?? undefined }, actor, (token) =>
      this.client.getMerchantSummary(merchantCode, token),
    );
  }

  @Get('tenants/:tenantId/summary')
  @Roles(...ALL_PORTAL_ROLES)
  async getTenantSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('tenantId', ParseIntPipe) tenantId: number,
  ): Promise<RewardTrackingProxyResponse> {
    // The requested path param is only ever used as a *fallback candidate* for resolver context —
    // RTS itself is the one that actually authorises `tenantId` against the caller's own claim
    // (`admin-rewards.controller.ts#getTenantSummary`: "a concrete claims.tenantId always wins
    // over the path param — a mismatch is a straight 403"). This controller does not re-decide
    // that; it only forwards both and lets RTS's own guard/controller answer (TC-4).
    return this.proxy({ tenantId: actor.tenantId ?? tenantId }, actor, (token) =>
      this.client.getTenantSummary(tenantId, token),
    );
  }

  /** See `admin-rewards.controller.ts`'s own header: only a `super_admin` token
   * (`countryId === null`) can reach RTS's country-summary endpoint today — a documented,
   * unresolved gap on RTS's own side, not something this proxy can or should paper over. */
  @Get('countries/:countryCode/summary')
  @Roles(...ALL_PORTAL_ROLES)
  async getCountrySummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('countryCode') countryCode: string,
  ): Promise<RewardTrackingProxyResponse> {
    return this.proxy({}, actor, (token) => this.client.getCountrySummary(countryCode, token));
  }

  @Get('alerts')
  @Roles(...ALL_PORTAL_ROLES)
  async getAlerts(@CurrentUser() actor: AuthenticatedUser): Promise<RewardTrackingProxyResponse> {
    return this.proxy({ tenantId: actor.tenantId ?? undefined }, actor, (token) =>
      this.client.getAlerts(token),
    );
  }

  /**
   * Resolves this leg's transport, fails closed on `GRPC` (see this file's header), mints one
   * fresh token for `actor`, and calls `restCall`. Every RTS rejection propagates untouched — this
   * method adds no `try`/`catch` of its own, so `RewardTrackingUpstreamRejectionError`'s real
   * upstream status always reaches `ErrorNormalizationFilter` unchanged.
   */
  private async proxy<T>(
    context: RewardTrackingChannelResolveContext,
    actor: AuthenticatedUser,
    restCall: (token: string) => Promise<T>,
  ): Promise<T> {
    const resolved = await this.resolver.resolve(context);

    if (resolved.primaryChannel === 'GRPC') {
      throw new RewardTrackingGrpcNotAvailableError({
        logMessage:
          'reward-tracking-service has no read-facing gRPC surface today (ingest-only) — this ' +
          "leg's resolved primary_channel is GRPC; failing closed rather than silently falling " +
          'back to REST (T-INT-030 TC-6: a deliberate primary switch must surface as a clear ' +
          'failure, never a silent reroute).',
        logContext: { resolvedPrimaryChannel: resolved.primaryChannel },
      });
    }
    if (!resolved.restEnabled) {
      throw new RewardTrackingServiceUnavailableError({
        logMessage:
          'REST is disabled on the resolved reward_tracking_channel_config row, and GRPC is not ' +
          'implemented for this leg — no transport available.',
      });
    }

    const token = this.tokens.mint(actor);
    return restCall(token);
  }
}
