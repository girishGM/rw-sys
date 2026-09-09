/**
 * T-INT-010 implementation note 2 — the REST surface's own identification layer, standing in for
 * `mtls.guard.ts` + `service-scope.guard.ts#resolve` on the gRPC transport.
 *
 * ### Same trust model, different identification column — the decision this file makes
 *
 * The task note asks: does this guard read `grpc_service_grants` with a different identification
 * column, or a new sibling table? Having read `grpc-grant.dto.ts` and `service-scope.guard.ts`
 * (both cited by the task): the table's own identification column, `service_identity`, is already
 * just a `varchar` — nothing in its schema or in `GrpcGrantsService#activeGrantsFor` requires it
 * to have come from a certificate SAN. **This guard reuses the same table, unmodified, by reusing
 * that column** — a caller names which identity's grants it wants via `X-Service-Identity`, and
 * `ServiceScopeGuard.resolve([identity])` (unmodified, gRPC's own method) does the rest: same
 * `PERMISSION_DENIED`-shaped refusal for an identity with no active grant, same tenant/section
 * resolution once `CampaignConfigService` runs. No migration, no new table.
 *
 * What a client certificate did for gRPC — *prove* the caller may claim that identity, not just
 * assert it — is done here by a **shared bearer secret** (`CAMPAIGN_CONFIG_API_TOKEN`), checked
 * before the identity header is even read. This is the same shape
 * `promo-code-service.client.ts`/`PROMO_CODE_SERVICE_INTERNAL_TOKEN` already uses for an outbound
 * machine call, applied here to an inbound one: one secret proves "you are a legitimate internal
 * caller of this surface," and the grants table (keyed by the identity you then name) decides
 * what you may read. Two factors, same as gRPC's "CA-signed cert" + "grant row", just split
 * across two headers instead of one TLS handshake.
 *
 * ### Why this is a Nest `@Controller`, unlike the gRPC/mTLS surface
 *
 * `campaign-config.controller.ts`'s own header explains why gRPC is deliberately *not* a Nest
 * controller: binding to a separate mTLS listener is what makes "portal cookies are rejected
 * here" a property of the socket. This surface is the opposite by design — a plain HTTPS
 * endpoint Render's free tier can serve without mTLS (ARCHITECTURE.md's whole reason for this
 * task) — so it necessarily sits on the same Express app as every browser route, and therefore
 * behind `JwtAuthGuard`/`SessionValidGuard`/`RolesGuard`/`PermissionsGuard`/`CsrfGuard`, all four
 * of the first two of which unconditionally require the portal's own session cookie unless the
 * route is `@Public()`. `campaign-config-api.controller.ts` marks its routes `@Public()` for
 * exactly that reason, and **this guard is what actually authenticates them** — `@Public()` only
 * means "no portal session required," never "no authentication required." See that controller's
 * own header for the disclosed, out-of-scope edit this required in
 * `test/security/route-inventory.e2e-spec.ts` (T-INT-010's Deviations).
 *
 * `CsrfGuard` needs no equivalent bypass: every route this module registers is a `GET`, and
 * `CSRF_EXEMPT_METHODS` already excludes GET/HEAD/OPTIONS globally.
 *
 * ### The cookie/CSRF-header isolation gRPC's `assertNoPortalCredentials` enforces, replicated
 *
 * TC-8 asks for the same isolation gRPC has: a portal browser session must not authorise this
 * surface. gRPC rejects the `authorization` header outright because *its* credential is a client
 * certificate; this surface's credential *is* an `authorization` bearer token, so only `cookie`
 * and `x-csrf-token` — the two headers a portal session actually arrives with — are rejected here.
 */
import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '@/config/env.schema';
import { SERVICE_IDENTITY_MAX_LENGTH } from '@/grpc/grpc.constants';
import { MutualTlsRequiredError } from '@/grpc/grpc.errors';
import { ServiceScopeGuard, type ResolvedServiceIdentity } from '@/grpc/service-scope.guard';

/** Headers that carry a portal session and therefore may not appear here (TC-8) — the REST
 * analogue of `mtls.guard.ts#REJECTED_PORTAL_HEADERS`, minus `authorization`: that header is
 * this surface's own credential, not a portal one. */
export const REJECTED_PORTAL_HEADERS: readonly string[] = Object.freeze(['cookie', 'x-csrf-token']);

/** The header naming which `grpc_service_grants.service_identity` row applies — the REST
 * equivalent of a certificate's SAN. */
export const SERVICE_IDENTITY_HEADER = 'x-service-identity';

/** An Express request after {@link ServiceApiAuthGuard} has run. */
export interface ServiceApiRequest extends Request {
  serviceCaller?: ResolvedServiceIdentity;
}

@Injectable()
export class ServiceApiAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly scopeGuard: ServiceScopeGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ServiceApiRequest>();

    for (const header of REJECTED_PORTAL_HEADERS) {
      const value = request.headers[header];
      const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '';
      if (present) {
        throw new UnauthorizedException(
          `portal session credentials are not accepted on this internal service surface ` +
            `(offending header: ${header})`,
        );
      }
    }

    const configured = this.config.get('CAMPAIGN_CONFIG_API_TOKEN', { infer: true });
    const presentedToken = bearerTokenOf(request.headers.authorization);
    // Fail closed: an unconfigured secret refuses every caller, never admits one (this file's
    // header, and env.schema.ts's own comment on this key).
    if (configured === undefined || configured === '' || presentedToken === null) {
      throw new UnauthorizedException('a valid service bearer token is required');
    }
    if (!constantTimeEquals(presentedToken, configured)) {
      throw new UnauthorizedException('a valid service bearer token is required');
    }

    const identityHeader = request.headers[SERVICE_IDENTITY_HEADER];
    const identity = typeof identityHeader === 'string' ? identityHeader.trim() : '';
    if (identity === '' || identity.length > SERVICE_IDENTITY_MAX_LENGTH) {
      throw new UnauthorizedException(
        `a ${SERVICE_IDENTITY_HEADER} header naming the caller's granted identity is required`,
      );
    }

    try {
      request.serviceCaller = await this.scopeGuard.resolve([identity]);
    } catch (error) {
      // `ServiceScopeGuard.resolve` throws `MutualTlsRequiredError` for "I do not know this
      // identity" — the gRPC name is about the transport it was written for, not about this one;
      // the underlying question ("does any active grant exist for this identity at all?") is
      // identical, so the same 401/403 split gRPC uses applies: unknown identity is 401
      // (UNAUTHENTICATED), a known identity's grant not covering what was asked is 403 and is
      // decided later, inside `CampaignConfigService` itself (TC-9), not here.
      if (error instanceof MutualTlsRequiredError) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }

    return true;
  }
}

/** `Authorization: Bearer <token>` → `<token>`, or `null` if the header is missing or a
 * different scheme. */
function bearerTokenOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : match[1];
}

/** `crypto.timingSafeEqual`, length-checked first — identical reasoning to
 * `csrf.guard.ts#constantTimeEquals`, restated here rather than imported: that function is
 * CSRF-guard-private in intent even though it happens to be exported, and this file's secret
 * comparison is conceptually unrelated to CSRF. */
function constantTimeEquals(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}

/** The caller `ServiceApiAuthGuard` resolved, exactly parallel to `@CurrentUser()` on the portal
 * session side. Throws rather than returning `undefined` — every route this decorator is used on
 * carries `@UseGuards(ServiceApiAuthGuard)`, so a missing value means the guard chain itself is
 * misconfigured, not that the caller is unauthenticated (that already threw, earlier). */
export const ServiceCaller = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResolvedServiceIdentity => {
    const request = context.switchToHttp().getRequest<ServiceApiRequest>();
    if (request.serviceCaller === undefined) {
      throw new ForbiddenException('service caller was not resolved — guard misconfiguration');
    }
    return request.serviceCaller;
  },
);
