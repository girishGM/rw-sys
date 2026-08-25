/**
 * T-015 — `/me`: the three routes the SPA cannot start without.
 *
 * The controller is thin, in the shape `auth.controller.ts` established: read the request, call a
 * service, set headers, shape a response. Two things are decided here rather than in a service,
 * because both are transport.
 *
 * ### Conditional GET, and why the handler writes the status itself
 *
 * `GET /me/bootstrap` answers `304 Not Modified` when the client's `If-None-Match` matches the
 * revision (implementation note 6, TC-12). Nest has no declarative form for a status that depends
 * on the request, so the handler takes `@Res({ passthrough: true })` and sets it — *passthrough*,
 * so the response still travels through the interceptor chain and the normal serialisation path.
 * A non-passthrough `@Res()` would take the response out of Nest's hands entirely, and with it
 * every response-side interceptor this application has or will have (T-018's payload encryption is
 * exactly such an interceptor).
 *
 * ### Caching headers, all three of them
 *
 *  - `Cache-Control: private, no-cache` (note 7). `private` keeps a shared cache from ever storing
 *    one user's menu; `no-cache` permits a *browser* copy but requires revalidation against the
 *    ETag before every use, which is what makes a permission change land on the next request.
 *  - `ETag` on both the 200 and the 304, because a 304 that omitted it would leave a client with
 *    nothing to revalidate against next time.
 *  - `Vary: Cookie`, appended rather than set (`res.vary`), so it composes with the `Vary: Origin`
 *    the CORS layer adds. The response depends entirely on which session cookie was presented;
 *    without it, a private cache keyed on URL alone could serve the previous user's bootstrap
 *    after a logout and a different login in the same browser. Not named in the task file — added
 *    because `private, no-cache` alone does not say *which* user the private copy belongs to.
 *
 * ### Authorisation
 *
 * `@Roles(...ALL_PORTAL_ROLES)` — 03-API-CONTRACT.md §3 marks `/me` reachable by any authenticated
 * role, and `RolesGuard` denies a route that declares no authorisation metadata at all (T-013
 * TC-18), so "everyone may" has to be said on purpose. There is no `@RequirePermission`: `/me` is
 * the caller's own identity, not an entity in `role_entity_permissions`, and gating it on a
 * configurable permission would let a Super Admin lock every user out of the portal with one row.
 *
 * There is deliberately **no** `@AllowWhilePasswordChangeRequired()`. 02-SECURITY.md §2 is exact:
 * *"`must_change_password = true` restricts the session to exactly two endpoints
 * (`/auth/change-password`, `/auth/logout`)"*. A confined session therefore gets 403 here, which
 * means the SPA must render its change-password screen from the login response's
 * `mustChangePassword` flag rather than from a bootstrap call. Flagged for T-020/T-024 in the
 * completion report; widening a confinement the security document states in absolute terms is not
 * this task's call to make (AGENT-PROTOCOL §7).
 */
import { Body, Controller, Get, HttpStatus, Patch, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { BootstrapService, ifNoneMatchSatisfiedBy } from './bootstrap.service';
import { MeService } from './me.service';
import {
  envelope,
  type BootstrapDto,
  type DataEnvelope,
  type MeProfileDto,
} from './dto/bootstrap-response.dto';
import { UpdateMeDto } from './dto/me-request.dto';

/**
 * The `Cache-Control` this endpoint sends (implementation note 7).
 *
 * Mirrored by `BOOTSTRAP_CACHE_CONTROL` in `packages/shared/src/bootstrap.schema.ts` for the SPA;
 * `test/me/bootstrap.contract.spec.ts` asserts the two strings are identical. Declared here rather
 * than imported from that package so the back end's runtime build has no cross-workspace import
 * for a constant.
 */
export const BOOTSTRAP_CACHE_CONTROL = 'private, no-cache';

@Controller('me')
// Every authenticated role, spelled out — see the header on why this is not the same as omitting
// the decorator.
@Roles(...ALL_PORTAL_ROLES)
export class MeController {
  constructor(
    private readonly bootstrap: BootstrapService,
    private readonly me: MeService,
  ) {}

  /**
   * `GET /me/bootstrap` — user, scope, nav, permissions, widgets and messages, in one call
   * (00-ARCHITECTURE.md §7).
   *
   * Returns `undefined` on the 304 path, which Nest's Express adapter renders as an empty body —
   * the only body a 304 may have.
   */
  @Get('bootstrap')
  async getBootstrap(
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DataEnvelope<BootstrapDto> | undefined> {
    const revision = await this.bootstrap.revision(actor);

    response.setHeader('ETag', revision.etag);
    response.setHeader('Cache-Control', BOOTSTRAP_CACHE_CONTROL);
    response.vary('Cookie');

    if (ifNoneMatchSatisfiedBy(readIfNoneMatch(request), revision.etag)) {
      response.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }

    return envelope(await this.bootstrap.assemble(actor, revision));
  }

  /** `GET /me` — the caller's own profile, and only ever the caller's own. */
  @Get()
  async getProfile(@CurrentUser() actor: AuthenticatedUser): Promise<DataEnvelope<MeProfileDto>> {
    return envelope(await this.me.getProfile(actor));
  }

  /**
   * `PATCH /me` — `displayName`, `preferredLocale`, `preferredTimezone` and nothing else.
   *
   * `{"role":"super_admin"}` and `{"tenantId":999}` are **400**s from the global `ValidationPipe`
   * before this method is entered (`forbidNonWhitelisted`), which is TC-16/TC-17. See
   * `dto/me-request.dto.ts` for the two further controls behind that one.
   */
  @Patch()
  @Audit({ event: 'profile_updated', targetType: 'portal_user' })
  async updateProfile(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdateMeDto,
  ): Promise<DataEnvelope<MeProfileDto>> {
    return envelope(await this.me.updateProfile(actor, dto));
  }
}

/**
 * The `If-None-Match` request header as a single string.
 *
 * Node lower-cases header names and collapses repeats of most headers, but `headers[x]` is typed
 * as `string | string[] | undefined` and a client is free to send the header twice. Joining with
 * `, ` produces exactly the comma-separated list RFC 7232 defines, so a repeated header behaves
 * identically to a single one carrying both tags — rather than the first one silently winning.
 */
function readIfNoneMatch(request: Request): string | undefined {
  const header = request.headers['if-none-match'];
  if (header === undefined) return undefined;
  return Array.isArray(header) ? header.join(', ') : header;
}
