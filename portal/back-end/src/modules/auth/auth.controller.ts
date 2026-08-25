/**
 * T-011 — `/auth/*`, the only place in the back end that touches a cookie.
 *
 * The controller is deliberately thin: read the request, call a service, write cookies, shape a
 * response DTO. Every decision worth arguing about lives in `auth.service.ts` or
 * `session.service.ts`, where it can be tested without a server. What *is* decided here is
 * transport, and two parts of that are security-relevant enough to state plainly.
 *
 * ### Cookies are set on exactly two paths and cleared on exactly two
 *
 * Set on login and on refresh; cleared on logout and on logout-all. Nothing else in this file —
 * or in the application — emits a `Set-Cookie` for these names, so "where could a token be
 * issued?" has a four-line answer. Clearing always goes through `buildClearCookie`, which reuses
 * the same `CookieDefinition` as the setter, because a cookie cleared with a different `Path` is
 * not cleared at all (T-011 implementation note 9).
 *
 * ### Which routes are `@Public()`, and why each one is
 *
 * `login`, `refresh`, `forgot-password` and `reset-password` — the exact four 03-API-CONTRACT.md
 * §15 enumerates, no more. `refresh` is public because its credential is the refresh cookie, not
 * an access token: requiring a valid access token to refresh would make the endpoint useless
 * fifteen minutes after login, which is the only moment anyone needs it.
 *
 * `logout` and `change-password` additionally carry `@AllowWhilePasswordChangeRequired()` —
 * these are the two routes a confined session may reach (implementation note 7). Every other
 * route in this controller is reachable only by an unconfined, fully authenticated session.
 *
 * ### On guard registration
 *
 * The three guards are applied to this controller with `@UseGuards`, not registered as global
 * `APP_GUARD`s. The global chain — and with it the "every route is guarded unless `@Public()`"
 * inventory check — is composed in T-013, which owns the ordering (00-ARCHITECTURE.md §6) and
 * whose TC-18 asserts that an unannotated route is denied. Registering them globally here would
 * silently 401 `GET /health`, a route this task does not own and cannot annotate. Flagged in the
 * completion report; T-013 is where it lands.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
// T-013: the class-level role gate below. Imported from the two source files rather than the
// `@/common/rbac` barrel, which also re-exports `PermissionRepository` and would pull the
// database layer into this module's import graph for no reason.
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
// T-018 — the ECDH handshake that binds a transport key to the session issued below.
import { HandshakeService } from '@/common/transport-crypto/handshake.service';
import {
  TRANSPORT_KID_HEADER,
  TRANSPORT_PUBLIC_KEY_HEADER,
} from '@/common/transport-crypto/transport-crypto.constants';
import {
  ALL_AUTH_COOKIES,
  ACCESS_COOKIE,
  CSRF_COOKIE,
  REFRESH_COOKIE,
  buildClearCookie,
  buildSetCookie,
  readCookie,
} from './auth.cookies';
import { NotFoundHttpException, SessionInvalidHttpException } from './auth.exceptions';
// T-055 — the MFA_PENDING cookie set on the step-up branch of login, and the decorator that keeps
// `logout` reachable while a challenge is outstanding.
import { MFA_PENDING_COOKIE } from './mfa.constants';
import { AllowWhileMfaPending } from './decorators/mfa-exempt.decorator';
import { AUTH_AUDIT_EVENT, REVOCATION_REASON } from './session.constants';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
} from './dto/auth-request.dto';
import {
  envelope,
  toLoginResponse,
  toSessionResponse,
  type DataEnvelope,
  type LoginResponseDto,
  type SessionResponseDto,
} from './dto/auth-response.dto';
import { CurrentUser, type AuthenticatedUser } from './decorators/current-user.decorator';
import { AllowWhilePasswordChangeRequired } from './decorators/password-change-exempt.decorator';
import { Public } from './decorators/public.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordChangeRequiredGuard } from './guards/password-change-required.guard';
import { SessionValidGuard } from './guards/session-valid.guard';
import type { IssuedSession, RequestContext } from './services/session.service';
import { SessionService } from './services/session.service';

/** A v4/v5 UUID, the shape `gen_random_uuid()` produces for `portal_sessions.id`. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('auth')
// Order matters and mirrors 00-ARCHITECTURE.md §6: authenticate, then check the session is
// alive, then check the session is not confined. Each guard re-reads `@Public()` itself rather
// than trusting its predecessor — see `public.decorator.ts`.
@UseGuards(JwtAuthGuard, SessionValidGuard, PasswordChangeRequiredGuard)
//
// T-013 added the class-level `@Roles`. `RolesGuard` now denies any non-`@Public()` route that
// declares no authorisation metadata (TC-18), so the authenticated half of this controller —
// `logout`, `logout-all`, `change-password`, `sessions`, `revokeSession` — has to say who may
// reach it. 03-API-CONTRACT.md §2 marks all of them **Access: any**, i.e. every authenticated
// role, which is what `ALL_PORTAL_ROLES` spells out.
//
// It does not affect the four `@Public()` handlers: every guard tests `@Public()` first and
// returns before it reads this metadata, so login and refresh stay reachable without a session.
@Roles(...ALL_PORTAL_ROLES)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    /** T-018. Injected here because §5 puts the handshake on the login request itself. */
    private readonly transport: HandshakeService,
  ) {}

  /**
   * `POST /auth/login`.
   *
   * Returns 200 with a body that contains no token of any kind (TC-5). On a step-up-required
   * outcome it sets **no cookies at all** — the union `AuthService.login` returns has no session
   * on that branch, so there is nothing here to forget to check.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DataEnvelope<LoginResponseDto>> {
    const result = await this.auth.login(
      { email: dto.email, password: dto.password },
      requestContext(request),
    );

    if (result.status === 'authenticated') {
      setSessionCookies(response, result.session);
      // T-018. The transport handshake, bound to the session that has just been issued. It runs
      // only on the `authenticated` branch: a step-up-required login has no session, so there is
      // nothing to key. A client that offered no public key gets `null` and no header, and the
      // request stays exactly as it was before this task — see `HandshakeService.establish`.
      await establishTransportKey(this.transport, request, response, result.session.sessionId);
      // T-055. A completed login supersedes any challenge left outstanding in this browser — for
      // instance a `super_admin` who abandoned an enrolment and then signed in as somebody else.
      // Without this the stale pending cookie would confine the *new*, perfectly valid session
      // until it expired.
      clearMfaPendingCookie(request, response);
    } else if (result.mfaPendingToken !== undefined) {
      // T-055. **Not** one of the three session cookies: a five-minute, httpOnly credential that
      // is worth nothing on its own — it names an account whose password has been verified and
      // buys access to `/auth/mfa/*` only (02-SECURITY.md §2a, `mfa.constants.ts`). The body
      // below is unchanged, which is what `LoginResponseDto.mfaRequired`'s comment promised the
      // SPA: `mfaRequired: true` and no token anywhere in the payload (T-011 TC-5/TC-26).
      response.append('Set-Cookie', buildSetCookie(MFA_PENDING_COOKIE, result.mfaPendingToken));
    }

    return envelope(
      toLoginResponse({
        role: result.user.role,
        mustChangePassword: result.mustChangePassword,
        mfaRequired: result.status === 'step_up_required',
      }),
    );
  }

  /**
   * `POST /auth/refresh` — rotation with reuse detection (02-SECURITY.md §3).
   *
   * On rejection the cookies are **cleared** as well as answering 401. A client left holding a
   * refresh cookie the server has revoked would retry with it forever; clearing it is what turns
   * a detected replay into a clean redirect to the login screen for the legitimate user.
   *
   * The response body is the same shape as login's, and is built from the *new* token's claims —
   * which, per AR-04, were re-derived from `portal_users` rather than copied from the token the
   * client presented (TC-27/TC-28).
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DataEnvelope<LoginResponseDto>> {
    const presented = readCookie(request.headers.cookie, REFRESH_COOKIE.name);
    if (presented === null) {
      clearSessionCookies(response);
      throw new SessionInvalidHttpException();
    }

    const outcome = await this.sessions.rotate(presented, requestContext(request), new Date());
    if (outcome.status === 'rejected') {
      clearSessionCookies(response);
      throw new SessionInvalidHttpException();
    }

    setSessionCookies(response, outcome.session);

    return envelope(
      toLoginResponse({
        // Both fields come from the same fresh read of `portal_users` that produced the new
        // token's claims (AR-04), so the body cannot disagree with the session it describes.
        role: outcome.session.claims.role,
        mustChangePassword: outcome.session.mustChangePassword,
        mfaRequired: false,
      }),
    );
  }

  /**
   * `POST /auth/logout` — revokes this session and its whole refresh family, clears cookies.
   *
   * T-055 added `@AllowWhileMfaPending()` so the exempt list is exactly the four routes
   * implementation note 4 names. Note what that does *not* do: a caller holding only a pending
   * token still gets 401 here, because `JwtAuthGuard` requires an access token and a pending
   * token is not one — which is precisely what "the `MFA_PENDING` token is not a session" means.
   * The decorator matters for the *other* direction: a `super_admin` who is logged in but not
   * enrolled can always log out.
   */
  @AllowWhilePasswordChangeRequired()
  @AllowWhileMfaPending()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.revoke(
      user.sessionId,
      REVOCATION_REASON.LOGOUT,
      { userId: user.userId, role: user.role },
      requestContext(request),
      AUTH_AUDIT_EVENT.LOGOUT,
    );
    // T-018 implementation note 7 — "logout / logout-all destroys it". The revocation above
    // already makes the key unreadable (the store selects `status = 'active'`); this removes the
    // ciphertext as well, so it is gone rather than merely unreachable.
    await this.transport.destroyForSession(user.sessionId);
    clearSessionCookies(response);
    clearMfaPendingCookie(request, response);
  }

  /** `POST /auth/logout-all` — every session for this user, including the current one (TC-18). */
  @AllowWhilePasswordChangeRequired()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.revokeAllForUser(
      user.userId,
      REVOCATION_REASON.LOGOUT_ALL,
      null,
      { userId: user.userId, role: user.role },
      requestContext(request),
      AUTH_AUDIT_EVENT.LOGOUT_ALL,
    );
    // T-018 — every session's key, matching the revocation's own breadth.
    await this.transport.destroyForUser(user.userId);
    clearSessionCookies(response);
    clearMfaPendingCookie(request, response);
  }

  /**
   * `POST /auth/change-password`.
   *
   * One of the two routes a `must_change_password` session may reach, which is the entire point
   * of the flag: the user can get out of the confinement, and can do nothing else until they do.
   */
  @AllowWhilePasswordChangeRequired()
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.auth.changePassword(
      user.userId,
      user.sessionId,
      { currentPassword: dto.currentPassword, newPassword: dto.newPassword },
      requestContext(request),
    );
  }

  /**
   * `POST /auth/forgot-password` — 204 for every input, in constant time (TC-21).
   *
   * The service is called **without `await`** on purpose; see its doc comment. Awaiting it here
   * would make the response time depend on whether the address exists, which is the one thing
   * this endpoint's design exists to hide.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() request: Request): void {
    this.auth.forgotPassword(dto.email, requestContext(request));
  }

  /** `POST /auth/reset-password` — single-use, expiring token (TC-22, TC-23). */
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() request: Request): Promise<void> {
    await this.auth.resetPassword(
      { token: dto.token, newPassword: dto.newPassword },
      requestContext(request),
    );
  }

  /** `GET /auth/sessions` — the caller's own live sessions and nothing else (TC-24). */
  @Get('sessions')
  async listSessions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DataEnvelope<SessionResponseDto[]>> {
    const sessions = await this.sessions.listForUser(user.userId, user.sessionId, new Date());
    return envelope(sessions.map(toSessionResponse));
  }

  /**
   * `DELETE /auth/sessions/:id` — revoke one of the caller's **own** sessions.
   *
   * Another user's session id answers 404, not 403, because a 403 would confirm the id names a
   * real session (02-SECURITY.md §5.1, TC-25). A malformed id answers 404 for the same reason
   * and, incidentally, keeps a non-UUID string from ever reaching a `uuid` column comparison.
   */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<void> {
    if (!UUID_PATTERN.test(id)) throw new NotFoundHttpException();

    const session = await this.sessions.findOwnedSession(id, user.userId);
    if (session === null) throw new NotFoundHttpException();

    await this.sessions.revoke(
      id,
      REVOCATION_REASON.USER_REVOKED,
      { userId: user.userId, role: user.role },
      requestContext(request),
      AUTH_AUDIT_EVENT.SESSION_REVOKED,
    );
  }
}

// --- transport helpers -----------------------------------------------------------------------

/**
 * What the transport layer knows about the caller. Forensic and rate-limiting data only — never
 * an input to an authorisation decision (R3).
 *
 * `request.ip` is Express's, which respects `trust proxy`; T-012 configures that from an
 * allowlist so a client cannot forge it with an `X-Forwarded-For` header of its own choosing.
 * Until then it is the socket address, which cannot be forged at all.
 *
 * Both fields tolerate absence. `user-agent` is trivially omitted by any non-browser client, and
 * `request.ip` is `undefined` on a request that never reached a socket — neither is exotic, and
 * neither may be allowed to throw on a route that runs before authentication. Exported so those
 * shapes can be asserted directly rather than by contorting a live HTTP request into producing
 * them.
 */
export function requestContext(request: Request): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}

/**
 * T-018 — completes the ECDH handshake and returns the server's public key, if the client
 * offered one.
 *
 * A **header** rather than a body field, in both directions, for two reasons: `LoginDto` stays a
 * credential DTO with no transport concern in it (and `forbidNonWhitelisted` keeps rejecting
 * everything it did before), and `LoginResponseDto` is untouched so T-011 TC-5 — "the login body
 * contains no token of any kind" — keeps asserting exactly what it asserted before this task.
 *
 * A public key sent twice arrives as an array and is ignored: a legitimate client does not do it,
 * and picking one of the two would be guessing which half of a confused request to trust.
 *
 * **Exported for `MfaController`** (T-018 retry 2, found by the six-role journey e2e). §5 says the
 * handshake happens "with the login request", and for five of the six roles the login request is
 * where the session is issued. For `super_admin` it is not: T-055 makes MFA structurally
 * mandatory, so `POST /auth/login` answers `mfaRequired: true` with **no** session and the session
 * is minted by `POST /auth/mfa/verify` (or `/recover`). Binding the key at login only would have
 * left the most privileged role in the system permanently unable to use payload encryption —
 * silently, because the encrypt interceptor falls back to cleartext when a session holds no key.
 * The handshake therefore runs wherever a session is *issued*, which is what §5 means. Shared
 * from here rather than duplicated, exactly as `requestContext` already is.
 */
export async function establishTransportKey(
  transport: HandshakeService,
  request: Request,
  response: Response,
  sessionId: string,
): Promise<void> {
  const offered = request.headers[TRANSPORT_PUBLIC_KEY_HEADER];
  const handshake = await transport.establish(
    sessionId,
    typeof offered === 'string' ? offered : undefined,
  );
  if (handshake === null) return;

  response.setHeader(TRANSPORT_PUBLIC_KEY_HEADER, handshake.serverPublicKey);
  response.setHeader(TRANSPORT_KID_HEADER, handshake.kid);
}

/** Emits all three `Set-Cookie` headers for a freshly-issued session (TC-1…TC-4). */
function setSessionCookies(response: Response, session: IssuedSession): void {
  response.append('Set-Cookie', buildSetCookie(ACCESS_COOKIE, session.accessToken));
  response.append('Set-Cookie', buildSetCookie(REFRESH_COOKIE, session.refreshToken));
  response.append('Set-Cookie', buildSetCookie(CSRF_COOKIE, session.csrfToken));
}

/** Clears all three, with attributes matching the setters exactly. */
function clearSessionCookies(response: Response): void {
  for (const cookie of ALL_AUTH_COOKIES) {
    response.append('Set-Cookie', buildClearCookie(cookie));
  }
}

/**
 * T-055 — drops an outstanding MFA challenge, but **only when the request actually carries one**.
 *
 * Conditional rather than unconditional so the response to an ordinary login or logout is
 * byte-identical to what it was before this task (T-011 TC-1/TC-16 assert the exact cookie set):
 * a `Set-Cookie` that clears a cookie the client does not have is noise in every response for the
 * benefit of a state almost nobody is in.
 *
 * Called on login-success, logout and logout-all. Leaving a pending cookie behind on any of those
 * would mean a stale five-minute credential confining the *next* session
 * (`MfaPendingConfinementGuard`) for no reason.
 */
function clearMfaPendingCookie(request: Request, response: Response): void {
  if (readCookie(request.headers.cookie, MFA_PENDING_COOKIE.name) === null) return;
  response.append('Set-Cookie', buildClearCookie(MFA_PENDING_COOKIE));
}
