/**
 * T-047 — the transport binding: bytes on the wire ⇄ the plain objects
 * `campaign-config.service.ts` works in.
 *
 * This is the only file that knows a request arrived over TLS on port 50051 rather than being a
 * function call, and it is deliberately thin: decode, run the three checks, call the service,
 * encode, log. Every decision worth arguing about lives in a file this one calls.
 *
 * It is **not** a Nest `@Controller`. A Nest controller is mounted on the Express app — the public
 * `/api/v1` surface, with the portal's cookie/CSRF/JWT chain in front of it — and 09-INTEGRATION.md
 * §7 says this surface must not share that trust domain. Binding these handlers to the internal
 * mTLS listener instead is what makes "portal cookies are rejected here" a property of the socket
 * rather than of a guard somebody could later remove.
 */
import { Injectable, Logger } from '@nestjs/common';
import { assertMutualTls, assertNoPortalCredentials } from './mtls.guard';
import { GrpcAccessLog } from './access-log';
import { GRPC_METHOD } from './grpc.constants';
import { GrpcError, GrpcStatus, type GrpcStatusCode } from './grpc.errors';
import { CampaignConfigService } from './campaign-config.service';
import { ServiceScopeGuard, type ResolvedServiceIdentity } from './service-scope.guard';
import { decodeMessage, encodeMessage } from './wire/proto-codec';
import {
  BudgetStatusRequestMessage,
  BudgetStatusResponseMessage,
  CampaignConfigListMessage,
  CampaignConfigMessage,
  ConfigChangeEventMessage,
  GetCampaignConfigRequestMessage,
  ListActiveCampaignsRequestMessage,
  ResolveRewardVersionRequestMessage,
  ResolveRuleVersionRequestMessage,
  RewardVersionDetailMessage,
  RuleVersionDetailMessage,
  WatchRequestMessage,
} from './wire/campaign-config.messages';
import type { CallContext, InternalTlsListener } from './wire/grpc-http2.server';

@Injectable()
export class CampaignConfigController {
  private readonly logger = new Logger(CampaignConfigController.name);

  constructor(
    private readonly service: CampaignConfigService,
    private readonly scopeGuard: ServiceScopeGuard,
    private readonly accessLog: GrpcAccessLog,
  ) {}

  /** Wires every RPC onto `listener`. Called once, by `grpc.module.ts`, at boot. */
  register(listener: InternalTlsListener): void {
    listener.registerUnary(GRPC_METHOD.GET_CAMPAIGN_CONFIG, async (context, body) => {
      const started = Date.now();
      const caller = await this.identify(context);
      const request = decodeMessage(GetCampaignConfigRequestMessage, body) as {
        tenantId: number;
        campaignCode: string;
        etag: string;
        sections: number[];
      };
      try {
        const { config, sections } = await this.service.getCampaignConfig(caller, request);
        this.accessLog.record({
          method: GRPC_METHOD.GET_CAMPAIGN_CONFIG,
          identity: caller.identity,
          tenantId: request.tenantId,
          campaignCode: request.campaignCode,
          sections: sections.returned,
          status: GrpcStatus.OK,
          durationMs: Date.now() - started,
        });
        return encodeMessage(CampaignConfigMessage, config);
      } catch (error) {
        this.logFailure(GRPC_METHOD.GET_CAMPAIGN_CONFIG, caller, request.tenantId, error, started, {
          campaignCode: request.campaignCode,
        });
        throw error;
      }
    });

    listener.registerUnary(GRPC_METHOD.LIST_ACTIVE_CAMPAIGNS, async (context, body) => {
      const started = Date.now();
      const caller = await this.identify(context);
      const request = decodeMessage(ListActiveCampaignsRequestMessage, body) as {
        tenantId: number;
        sections: number[];
      };
      try {
        const { list, sections } = await this.service.listActiveCampaigns(caller, request);
        this.accessLog.record({
          method: GRPC_METHOD.LIST_ACTIVE_CAMPAIGNS,
          identity: caller.identity,
          tenantId: request.tenantId,
          sections: sections.returned,
          status: GrpcStatus.OK,
          durationMs: Date.now() - started,
        });
        return encodeMessage(CampaignConfigListMessage, list);
      } catch (error) {
        this.logFailure(
          GRPC_METHOD.LIST_ACTIVE_CAMPAIGNS,
          caller,
          request.tenantId,
          error,
          started,
        );
        throw error;
      }
    });

    listener.registerUnary(GRPC_METHOD.RESOLVE_RULE_VERSION, async (context, body) => {
      const started = Date.now();
      const caller = await this.identify(context);
      const request = decodeMessage(ResolveRuleVersionRequestMessage, body) as {
        tenantId: number;
        ruleId: number;
        versionNo: number;
      };
      try {
        const detail = await this.service.resolveRuleVersion(caller, request);
        this.accessLog.record({
          method: GRPC_METHOD.RESOLVE_RULE_VERSION,
          identity: caller.identity,
          tenantId: request.tenantId,
          status: GrpcStatus.OK,
          durationMs: Date.now() - started,
        });
        return encodeMessage(RuleVersionDetailMessage, detail);
      } catch (error) {
        this.logFailure(GRPC_METHOD.RESOLVE_RULE_VERSION, caller, request.tenantId, error, started);
        throw error;
      }
    });

    listener.registerUnary(GRPC_METHOD.RESOLVE_REWARD_VERSION, async (context, body) => {
      const started = Date.now();
      const caller = await this.identify(context);
      const request = decodeMessage(ResolveRewardVersionRequestMessage, body) as {
        tenantId: number;
        rewardId: number;
        versionNo: number;
      };
      try {
        const detail = await this.service.resolveRewardVersion(caller, request);
        this.accessLog.record({
          method: GRPC_METHOD.RESOLVE_REWARD_VERSION,
          identity: caller.identity,
          tenantId: request.tenantId,
          status: GrpcStatus.OK,
          durationMs: Date.now() - started,
        });
        return encodeMessage(RewardVersionDetailMessage, detail);
      } catch (error) {
        this.logFailure(
          GRPC_METHOD.RESOLVE_REWARD_VERSION,
          caller,
          request.tenantId,
          error,
          started,
        );
        throw error;
      }
    });

    listener.registerUnary(GRPC_METHOD.GET_BUDGET_STATUS, async (context, body) => {
      const started = Date.now();
      const caller = await this.identify(context);
      const request = decodeMessage(BudgetStatusRequestMessage, body) as {
        tenantId: number;
        campaignCode: string;
      };
      try {
        const status = await this.service.getBudgetStatus(caller, request);
        this.accessLog.record({
          method: GRPC_METHOD.GET_BUDGET_STATUS,
          identity: caller.identity,
          tenantId: request.tenantId,
          campaignCode: request.campaignCode,
          status: GrpcStatus.OK,
          durationMs: Date.now() - started,
        });
        return encodeMessage(BudgetStatusResponseMessage, status);
      } catch (error) {
        this.logFailure(GRPC_METHOD.GET_BUDGET_STATUS, caller, request.tenantId, error, started, {
          campaignCode: request.campaignCode,
        });
        throw error;
      }
    });

    listener.registerStream(
      GRPC_METHOD.WATCH_CAMPAIGN_CONFIG,
      async (context, body, emit, signal) => {
        const started = Date.now();
        const caller = await this.identify(context);
        const request = decodeMessage(WatchRequestMessage, body) as { tenantId: number };
        try {
          await this.service.watchCampaignConfig(
            caller,
            request.tenantId,
            (event) => emit(encodeMessage(ConfigChangeEventMessage, event)),
            signal,
          );
          this.accessLog.record({
            method: GRPC_METHOD.WATCH_CAMPAIGN_CONFIG,
            identity: caller.identity,
            tenantId: request.tenantId,
            status: GrpcStatus.OK,
            durationMs: Date.now() - started,
          });
        } catch (error) {
          this.logFailure(
            GRPC_METHOD.WATCH_CAMPAIGN_CONFIG,
            caller,
            request.tenantId,
            error,
            started,
          );
          throw error;
        }
      },
    );
  }

  /**
   * Checks 1 and 2 of `mtls.guard.ts`'s list, for every RPC without exception.
   *
   * Written once, here, rather than per handler: a method that forgot to call it would be
   * unauthenticated, and "did this handler remember?" is not a question anyone should have to ask
   * six times.
   */
  private async identify(context: CallContext): Promise<ResolvedServiceIdentity> {
    assertNoPortalCredentials(context.headers);
    const candidates = assertMutualTls(context.peer);
    return this.scopeGuard.resolve(candidates);
  }

  private logFailure(
    method: string,
    caller: ResolvedServiceIdentity,
    tenantId: number,
    error: unknown,
    started: number,
    extra: { campaignCode?: string } = {},
  ): void {
    const status: GrpcStatusCode = error instanceof GrpcError ? error.status : GrpcStatus.INTERNAL;
    this.accessLog.record({
      method,
      identity: caller.identity,
      tenantId,
      campaignCode: extra.campaignCode ?? null,
      status,
      durationMs: Date.now() - started,
    });
    if (!(error instanceof GrpcError)) {
      this.logger.error(
        `unexpected failure in ${method} for ${caller.identity}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
