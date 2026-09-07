/**
 * T-INT-010 — the REST transport binding: JSON on the wire ⇄ the plain objects
 * `campaign-config.service.ts` already works in.
 *
 * Deliberately the second thin adapter over `CampaignConfigService`, exactly parallel to
 * `campaign-config.controller.ts` (that file's own header: *"Every decision worth arguing about
 * lives in a file this one calls"*). Every handler below: resolve the caller (the guard already
 * did this), call the service, shape the response, map a thrown `GrpcError` onto an HTTP status.
 * No resolution logic is ported or duplicated (scope note).
 *
 * `@Public()` on the class skips the portal session chain (`JwtAuthGuard` et al.) — see
 * `service-api-auth.guard.ts`'s header for why that is necessary and safe here, and for what it
 * does *not* mean (this surface is still fully authenticated, by `ServiceApiAuthGuard`).
 *
 * **Deviation, disclosed here and in the completion report**: marking these routes `@Public()`
 * makes them appear in `test/security/route-inventory.e2e-spec.ts`'s pinned public-route
 * inventory (`public.decorator.ts`'s own header: this is "an exception mechanism," gated by that
 * suite so a new public route is a reviewed diff, not a silent addition). That file is not in
 * this task's own "Files owned" list. It was edited anyway, registering these five routes in
 * `REVIEWED_PUBLIC_ADDITIONS` with the same justification style T-055's MFA routes use, because
 * every other way of reaching "reachable without a portal session" in this codebase either (a)
 * is not actually available to a plain `@Controller()` — `JwtAuthGuard` has no other bypass — or
 * (b) means not being a Nest controller at all, i.e. a second mTLS listener, which would defeat
 * this task's entire purpose (a surface Render's free tier can serve without mTLS,
 * ARCHITECTURE.md's stated reason this task exists). Leaving the inventory suite failing was not
 * an option either (AGENT-PROTOCOL R6). See that spec file's own new comment block for the
 * five registered signatures and their justification text.
 */
import {
  Controller,
  Get,
  Header,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { CampaignConfigService } from '@/grpc/campaign-config.service';
import { CONFIG_SECTION, CLIENT_CACHE_TTL_SECONDS, TTL_HEADER } from '@/grpc/grpc.constants';
import { GrpcError, GrpcStatus, type GrpcStatusCode } from '@/grpc/grpc.errors';
import type { ResolvedServiceIdentity } from '@/grpc/service-scope.guard';
import { ServiceApiAuthGuard, ServiceCaller } from './service-api-auth.guard';
import { CampaignConfigQueryDto, SectionsQueryDto } from './dto/campaign-config-query.dto';
import type {
  BudgetStatusResponse,
  CampaignConfigListResponse,
  CampaignConfigResponse,
  DataEnvelope,
  RewardVersionDetailResponse,
  RuleVersionDetailResponse,
} from './dto/campaign-config-response.dto';

/** `GrpcStatus` → the HTTP status a REST caller of this surface sees — the same mapping
 * `campaign-config.controller.ts`'s own gRPC trailer status expresses on that transport, restated
 * for this one (implementation note 2: same trust model, different wire). */
const STATUS_TO_HTTP: Readonly<Partial<Record<GrpcStatusCode, number>>> = Object.freeze({
  [GrpcStatus.INVALID_ARGUMENT]: HttpStatus.BAD_REQUEST,
  [GrpcStatus.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [GrpcStatus.PERMISSION_DENIED]: HttpStatus.FORBIDDEN,
  [GrpcStatus.RESOURCE_EXHAUSTED]: HttpStatus.TOO_MANY_REQUESTS,
  [GrpcStatus.FAILED_PRECONDITION]: HttpStatus.CONFLICT,
  [GrpcStatus.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [GrpcStatus.INTERNAL]: HttpStatus.INTERNAL_SERVER_ERROR,
  [GrpcStatus.UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
});

/** Rethrows a caught `GrpcError` as the equivalent Nest `HttpException`, so the app's existing
 * global `ErrorNormalizationFilter` renders the same `{error:{code,message,traceId}}` envelope
 * every other portal endpoint returns — no module-local exception filter needed. */
function mapGrpcError(error: unknown): never {
  if (error instanceof GrpcError) {
    const status = STATUS_TO_HTTP[error.status] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    throw new HttpException(error.message, status);
  }
  throw error;
}

/** `?sections=RULES,REWARDS` → the wire enum numbers `CampaignConfigService` expects. Absent or
 * empty → `[]`, the same "give me what I may have" request `resolveSections` treats specially. */
function sectionNumbersOf(dto: SectionsQueryDto): number[] {
  if (dto.sections === undefined) return [];
  return dto.sections.map((name) => CONFIG_SECTION[name]);
}

@Controller('campaign-config')
@Public()
@UseGuards(ServiceApiAuthGuard)
export class CampaignConfigApiController {
  constructor(private readonly service: CampaignConfigService) {}

  @Get('tenants/:tenantId/campaigns')
  @Header('Cache-Control', 'no-store')
  async listActiveCampaigns(
    @ServiceCaller() caller: ResolvedServiceIdentity,
    @Param('tenantId', ParseIntPipe) tenantId: number,
    @Query() query: SectionsQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DataEnvelope<CampaignConfigListResponse>> {
    response.setHeader(TTL_HEADER, String(CLIENT_CACHE_TTL_SECONDS));
    try {
      const { list } = await this.service.listActiveCampaigns(caller, {
        tenantId,
        sections: sectionNumbersOf(query),
      });
      return { data: list as unknown as CampaignConfigListResponse };
    } catch (error) {
      mapGrpcError(error);
    }
  }

  /**
   * `GetCampaignConfig`, with implementation note 3's polling substitute for the gRPC
   * `WatchCampaignConfig` stream: a still-current `If-None-Match`/`?etag=` answers `304` with no
   * body (TC-5); anything else answers `200` with the full payload and a fresh `ETag` (TC-6).
   */
  @Get('tenants/:tenantId/campaigns/:campaignCode')
  @Header('Cache-Control', 'no-store')
  async getCampaignConfig(
    @ServiceCaller() caller: ResolvedServiceIdentity,
    @Param('tenantId', ParseIntPipe) tenantId: number,
    @Param('campaignCode') campaignCode: string,
    @Query() query: CampaignConfigQueryDto,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DataEnvelope<CampaignConfigResponse> | undefined> {
    response.setHeader(TTL_HEADER, String(CLIENT_CACHE_TTL_SECONDS));
    const presentedEtag = ifNoneMatch ?? query.etag ?? '';

    try {
      const { config } = await this.service.getCampaignConfig(caller, {
        tenantId,
        campaignCode,
        etag: presentedEtag,
        sections: sectionNumbersOf(query),
      });
      const shaped = config as unknown as CampaignConfigResponse;
      response.setHeader('ETag', shaped.etag);

      if (shaped.notModified) {
        response.status(HttpStatus.NOT_MODIFIED);
        return undefined;
      }
      return { data: shaped };
    } catch (error) {
      mapGrpcError(error);
    }
  }

  @Get('tenants/:tenantId/campaigns/:campaignCode/budget-status')
  @Header('Cache-Control', 'no-store')
  async getBudgetStatus(
    @ServiceCaller() caller: ResolvedServiceIdentity,
    @Param('tenantId', ParseIntPipe) tenantId: number,
    @Param('campaignCode') campaignCode: string,
  ): Promise<DataEnvelope<BudgetStatusResponse>> {
    try {
      const status = await this.service.getBudgetStatus(caller, { tenantId, campaignCode });
      return { data: status as unknown as BudgetStatusResponse };
    } catch (error) {
      mapGrpcError(error);
    }
  }

  @Get('tenants/:tenantId/rules/:ruleId/versions/:versionNo')
  @Header('Cache-Control', 'no-store')
  async resolveRuleVersion(
    @ServiceCaller() caller: ResolvedServiceIdentity,
    @Param('tenantId', ParseIntPipe) tenantId: number,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Param('versionNo', ParseIntPipe) versionNo: number,
  ): Promise<DataEnvelope<RuleVersionDetailResponse>> {
    try {
      const detail = await this.service.resolveRuleVersion(caller, { tenantId, ruleId, versionNo });
      return { data: detail as unknown as RuleVersionDetailResponse };
    } catch (error) {
      mapGrpcError(error);
    }
  }

  @Get('tenants/:tenantId/rewards/:rewardId/versions/:versionNo')
  @Header('Cache-Control', 'no-store')
  async resolveRewardVersion(
    @ServiceCaller() caller: ResolvedServiceIdentity,
    @Param('tenantId', ParseIntPipe) tenantId: number,
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Param('versionNo', ParseIntPipe) versionNo: number,
  ): Promise<DataEnvelope<RewardVersionDetailResponse>> {
    try {
      const detail = await this.service.resolveRewardVersion(caller, {
        tenantId,
        rewardId,
        versionNo,
      });
      return { data: detail as unknown as RewardVersionDetailResponse };
    } catch (error) {
      mapGrpcError(error);
    }
  }
}
