/**
 * T-INT-020. `ProgressQueryService` — the gRPC equivalent of `ProgressController`'s (REST) two
 * routes (`src/modules/progress-api/progress.controller.ts`, T-RAP-040). Per this codebase's own
 * "no business logic in a transport adapter" convention (see `activity-ingest.controller.ts`'s own
 * header, informally "R5"), this controller does exactly what its REST sibling does: destructure
 * params, authenticate, and delegate to `ProgressService.getCampaignProgress()`/
 * `getTrackerProgress()` — the identical domain provider the REST surface already uses, wired in
 * by `grpc.module.ts` (see that file's own header for why it's wired in directly rather than via a
 * plain `ProgressApiModule` import), never a second copy of it.
 *
 * ## Auth — a deliberate deviation from this file's own sibling (`ActivityIngestController`)
 *
 * `ActivityIngestController` is guarded by `MtlsGuard` (a **service**-identity model: a client
 * certificate resolves to a `tenantId`). This controller carries the **same** trust model as its
 * REST sibling instead — a bearer token asserting *"the bearer may read this one customerId's
 * progress, in this one tenant"*, verified via `verifyProgressApiToken()`/
 * `PROGRESS_API_AUTH_SECRET` (`progress-api-token.ts`), the exact function
 * `ProgressApiAuthGuard.canActivate` already calls for the REST transport. Deliberately **not**
 * `MtlsGuard`/`ServiceIdentityRegistry` — there is no per-customer client certificate to check, and
 * reusing the service-identity allowlist for a customer-scoped read would conflate two different
 * trust domains (same reasoning `progress-api-token.ts`'s own header already applies to the REST
 * guard). Flagged here explicitly, per this task's own Implementation note 2, so a reviewer isn't
 * surprised this is the one controller in `src/grpc/` that doesn't use `MtlsGuard`.
 *
 * No `CanActivate` guard class is added for this (unlike `MtlsGuard`/`ProgressApiAuthGuard`) —
 * this task's own "Files owned" list has no room for a new guard file, and unlike an HTTP
 * `ExecutionContext`, a gRPC unary handler already receives `(data, metadata, call)` directly, so
 * `authenticate()` below is a plain private method rather than a class of its own. If a second gRPC
 * service ever needs this identical bearer-token check, promoting this into a shared guard is a
 * reasonable follow-up, not required by this task.
 *
 * ## `PROGRESS_API_AUTH_SECRET` is loaded lazily, not eagerly, in this controller
 *
 * `ProgressApiAuthGuard` (REST) loads its secret eagerly, at construction time — appropriate
 * there, since that guard is only ever constructed as part of a request through
 * `ProgressController`, a controller that already requires this env var to do anything useful.
 * `ProgressQueryController` is different: Nest instantiates **every** registered controller in a
 * module eagerly at boot, whether or not any RPC on it is ever called — and `grpc.module.ts` wires
 * this controller into the **same** `GrpcModule` every existing test/deployment that boots
 * `GrpcMicroserviceRootModule` already depends on (`ActivityIngestService`'s own tests, the future
 * hybrid `AppModule` bootstrap). Loading the secret eagerly here would turn
 * `PROGRESS_API_AUTH_SECRET` into a new, silent boot-time requirement for *every* caller of this
 * gRPC server, including ones that only ever call `ActivityIngestService` and never
 * `ProgressQueryService` — confirmed against a real run: it broke `test/grpc/grpc-server.e2e-spec.ts`
 * and `test/main/hybrid-bootstrap.e2e-spec.ts` (both pre-existing, neither owned by this task)
 * before this method below was made lazy instead. The "no default, no fallback" guarantee
 * (`AGENT-PROTOCOL.md` R8's spirit) still holds — a genuinely missing/invalid secret still throws,
 * just on the first real `ProgressQueryService` call rather than at provider construction, which is
 * the earliest point this specific wiring can afford to fail loudly without over-widening what
 * "misconfigured" means for a shared, multi-service gRPC server.
 */
import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import {
  InvalidProgressApiTokenError,
  loadProgressApiAuthSecret,
  verifyProgressApiToken,
  type ProgressApiTokenClaims,
} from '@/modules/progress-api/progress-api-token';
import { ProgressService } from '@/modules/progress-api/progress.service';
import type {
  ComponentProgressView,
  TrackerProgressView,
} from '@/modules/progress-api/progress.types';
import type {
  CampaignProgressResponseProto,
  ComponentProgressViewProto,
  GetCampaignProgressRequestProto,
  GetTrackerProgressRequestProto,
  TrackerProgressResponseProto,
  TrackerProgressViewProto,
} from './progress-query.grpc.types';

/** Distinct from `rewardrap.ingest.v1` (`activity_ingest.proto`'s own package) so both proto files
 * load side by side onto the one gRPC server (`grpc-server.bootstrap.ts`'s own edit for this
 * task). */
export const PROGRESS_QUERY_PACKAGE_NAME = 'rewardrap.progress.v1';
export const PROGRESS_QUERY_SERVICE_NAME = 'ProgressQueryService';

const BEARER_PREFIX = 'Bearer ';

function unauthenticated(message: string): never {
  throw new RpcException({ code: GrpcStatus.UNAUTHENTICATED, message });
}

function permissionDenied(message: string): never {
  throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message });
}

function invalidArgument(message: string): never {
  throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message });
}

function requireNonEmpty(value: string | undefined, fieldName: string): string {
  if (!value || value.trim().length === 0) {
    invalidArgument(`${fieldName} is required`);
  }
  return value;
}

function toComponentProto(view: ComponentProgressView): ComponentProgressViewProto {
  return {
    componentCode: view.componentCode,
    currentCount: view.currentCount,
    requiredCount: view.requiredCount,
    isCompleted: view.isCompleted,
  };
}

function toTrackerProto(view: TrackerProgressView): TrackerProgressViewProto {
  return {
    trackerCode: view.trackerCode,
    // `null` -> `""` (proto3 has no null — this file's own `.proto` header, `progress-query.grpc
    // .types.ts`'s own header).
    completionLogic: view.completionLogic ?? '',
    isCompleted: view.isCompleted,
    completedAt: view.completedAt ?? '',
    componentsRequiredCount: view.componentsRequiredCount,
    componentsCompletedCount: view.componentsCompletedCount,
    components: view.components.map(toComponentProto),
  };
}

@Controller()
export class ProgressQueryController {
  private readonly logger = new Logger(ProgressQueryController.name);

  // Lazily loaded and cached on first use, not at provider-construction time — see this file's
  // own header ("`PROGRESS_API_AUTH_SECRET` is loaded lazily...") for why.
  private cachedSecret: Buffer | undefined;

  constructor(private readonly progressService: ProgressService) {}

  private loadSecret(): Buffer {
    if (this.cachedSecret === undefined) {
      this.cachedSecret = loadProgressApiAuthSecret();
    }
    return this.cachedSecret;
  }

  @GrpcMethod(PROGRESS_QUERY_SERVICE_NAME, 'GetCampaignProgress')
  async getCampaignProgress(
    data: GetCampaignProgressRequestProto,
    metadata: Metadata,
  ): Promise<CampaignProgressResponseProto> {
    const customerId = requireNonEmpty(data.customerId, 'customer_id');
    const campaignCode = requireNonEmpty(data.campaignCode, 'campaign_code');
    const claims = this.authenticate(metadata, customerId);

    this.logger.log('GetCampaignProgress');
    const result = await this.progressService.getCampaignProgress(
      claims.tenantId,
      customerId,
      campaignCode,
    );

    return {
      customerId: result.customerId,
      campaignCode: result.campaignCode,
      trackers: result.trackers.map(toTrackerProto),
    };
  }

  @GrpcMethod(PROGRESS_QUERY_SERVICE_NAME, 'GetTrackerProgress')
  async getTrackerProgress(
    data: GetTrackerProgressRequestProto,
    metadata: Metadata,
  ): Promise<TrackerProgressResponseProto> {
    const customerId = requireNonEmpty(data.customerId, 'customer_id');
    const campaignCode = requireNonEmpty(data.campaignCode, 'campaign_code');
    const trackerCode = requireNonEmpty(data.trackerCode, 'tracker_code');
    const claims = this.authenticate(metadata, customerId);

    this.logger.log('GetTrackerProgress');
    const result = await this.progressService.getTrackerProgress(
      claims.tenantId,
      customerId,
      campaignCode,
      trackerCode,
    );

    return {
      customerId: result.customerId,
      campaignCode: result.campaignCode,
      trackerCode: result.trackerCode,
      completionLogic: result.completionLogic ?? '',
      isCompleted: result.isCompleted,
      completedAt: result.completedAt ?? '',
      componentsRequiredCount: result.componentsRequiredCount,
      componentsCompletedCount: result.componentsCompletedCount,
      components: result.components.map(toComponentProto),
    };
  }

  /**
   * Mirrors `ProgressApiAuthGuard.canActivate` (REST) exactly, over gRPC metadata instead of an
   * HTTP header: reads `authorization` (`Bearer <token>`) from the call's own `Metadata`, verifies
   * it via the same `verifyProgressApiToken()` REST already uses, and enforces the identical
   * cross-customer check — a valid token for a *different* `customerId` than requested is
   * `PERMISSION_DENIED` (this transport's own equivalent of REST's `403 Forbidden`, TC-4).
   */
  private authenticate(metadata: Metadata, requestedCustomerId: string): ProgressApiTokenClaims {
    const values = metadata.get('authorization');
    const header = values.length > 0 ? values[0] : undefined;
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
      unauthenticated('Missing bearer token');
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token.length === 0) {
      unauthenticated('Missing bearer token');
    }

    let claims: ProgressApiTokenClaims;
    try {
      claims = verifyProgressApiToken(token, this.loadSecret());
    } catch (error) {
      if (error instanceof InvalidProgressApiTokenError) {
        unauthenticated('Invalid or expired token');
      }
      throw error;
    }

    if (claims.customerId !== requestedCustomerId) {
      permissionDenied('Token is not authorized for this customerId');
    }
    return claims;
  }
}
