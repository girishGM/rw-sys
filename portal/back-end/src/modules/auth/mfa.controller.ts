/**
 * T-055 — `/auth/mfa/*`: enrol, verify, recover (02-SECURITY.md §2a).
 *
 * Thin, exactly as `auth.controller.ts` is: read the request, call `MfaService`, write cookies,
 * shape a DTO. Every decision worth arguing about lives in the service, where it is testable
 * without a server. What is decided *here* is transport, and three parts of it matter.
 *
 * ### 1. Why all three routes are `@Public()`
 *
 * Their credential is the `MFA_PENDING` token, not a session — a caller who had a session would
 * have no reason to be here. `@Public()` is what lets a request with no access cookie reach the
 * handler at all; the pending token is then verified by `MfaService`, which refuses everything
 * else. This is the same shape `POST /auth/refresh` already has (a `@Public()` route whose
 * credential is a cookie rather than an access token), and the same reasoning: requiring an
 * access token here would make the endpoint unreachable in the only state anybody needs it.
 *
 * ### 2. Why all three carry `@AllowWhileMfaPending()`
 *
 * Because `MfaPendingConfinementGuard` confines a pending caller *everywhere else*
 * (implementation note 4). These three routes plus `/auth/logout` are the exempt list, and the
 * inventory test in `mfa.e2e-spec.ts` fails if a fifth ever appears without being noticed.
 *
 * ### 3. Cookies are set on exactly one path here, and cleared on two
 *
 * Set on a satisfied challenge (`verify`, `recover`) — the same three cookies a password-only
 * login sets, built from the same definitions, so there is one place in the codebase where a
 * session cookie's attributes are written down. The pending cookie is cleared on both of those
 * paths: the challenge it represented is over, and a credential that has served its purpose
 * should not sit in the jar for the remainder of its five minutes.
 *
 * ### 4. And the transport handshake happens on the same two paths (T-018)
 *
 * Appended by T-018 after its six-role journey e2e caught the gap. 07-DATA-PROTECTION.md §5 puts
 * the ECDH handshake "with the login request" because that is where a session is issued — but for
 * `super_admin`, and only for `super_admin`, this task moved that moment here. A key bound at
 * login only would have meant the one role with unrestricted scope could never encrypt a payload,
 * and would have failed *invisibly*: `PayloadEncryptInterceptor` returns the body in cleartext
 * when the session holds no key, so nothing would have gone red. Whatever mints the session
 * completes the handshake; `establishTransportKey` is imported from `auth.controller.ts` rather
 * than reimplemented, so both paths read the same header, write the same two headers, and treat a
 * client that offered no public key the same way (no handshake, unchanged response).
 */
import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  REFRESH_COOKIE,
  buildClearCookie,
  buildSetCookie,
  readCookie,
} from './auth.cookies';
// T-018 — the handshake helper, shared from the controller that owns it. See point 4 above.
import { HandshakeService } from '@/common/transport-crypto/handshake.service';
import { establishTransportKey, requestContext } from './auth.controller';
import { envelope, type DataEnvelope } from './dto/auth-response.dto';
import { MfaEnrolDto, MfaRecoverDto, MfaVerifyDto } from './dto/mfa-request.dto';
import {
  toEnrolmentResponse,
  toVerifiedResponse,
  type MfaEnrolmentResponseDto,
  type MfaVerifiedResponseDto,
} from './dto/mfa-response.dto';
import { AllowWhileMfaPending } from './decorators/mfa-exempt.decorator';
import { Public } from './decorators/public.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MFA_PENDING_COOKIE } from './mfa.constants';
import { MfaService, type MfaLoginResult } from './services/mfa.service';

@Controller('auth/mfa')
// `JwtAuthGuard` is applied for the same reason `AuthController` applies its three: T-013's
// Rollback procedure removes the global chain, and a rollback that left these routes unguarded
// would be worse than the duplicated check. It is a no-op while every route here is `@Public()`
// — the guard reads that first — and it is the thing that keeps them closed if one ever is not.
@UseGuards(JwtAuthGuard)
@Public()
@AllowWhileMfaPending()
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    /** T-018. `AuthModule` already imports `TransportHandshakeModule` for `AuthController`. */
    private readonly transport: HandshakeService,
  ) {}

  /**
   * `POST /auth/mfa/enrol` — mint a seed and show it once (TC-1, TC-5).
   *
   * 200 rather than 201: nothing addressable is created, and the SPA's handling is "render this
   * payload", not "follow a Location header".
   */
  @Post('enrol')
  @HttpCode(HttpStatus.OK)
  async enrol(
    @Body() dto: MfaEnrolDto,
    @Req() request: Request,
  ): Promise<DataEnvelope<MfaEnrolmentResponseDto>> {
    const offer = await this.mfa.beginEnrolment(
      pendingTokenFrom(dto.mfaPendingToken, request),
      requestContext(request),
    );

    return envelope(toEnrolmentResponse(offer));
  }

  /** `POST /auth/mfa/verify` — the TOTP challenge, and the second half of enrolment (TC-6). */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Body() dto: MfaVerifyDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DataEnvelope<MfaVerifiedResponseDto>> {
    const result = await this.mfa.verifyChallenge(
      {
        pendingToken: pendingTokenFrom(dto.mfaPendingToken, request),
        code: dto.totpCode,
      },
      requestContext(request),
    );

    return this.completeChallenge(request, response, result);
  }

  /** `POST /auth/mfa/recover` — one single-use recovery code, for a lost device (TC-11). */
  @Post('recover')
  @HttpCode(HttpStatus.OK)
  async recover(
    @Body() dto: MfaRecoverDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DataEnvelope<MfaVerifiedResponseDto>> {
    const result = await this.mfa.recover(
      {
        pendingToken: pendingTokenFrom(dto.mfaPendingToken, request),
        recoveryCode: dto.recoveryCode,
      },
      requestContext(request),
    );

    return this.completeChallenge(request, response, result);
  }

  /**
   * The shared success path: three cookies on, the pending cookie off, the transport key bound,
   * one body shape.
   *
   * The handshake is `await`ed **after** the cookies are written and before the body is returned,
   * in the same position `AuthController.login` puts it. It cannot fail the challenge: a client
   * that offers no public key, or an unusable one, gets `null` back and no headers, and the
   * response is byte-identical to what T-055 produced (see `HandshakeService.establish`).
   */
  private async completeChallenge(
    request: Request,
    response: Response,
    result: MfaLoginResult,
  ): Promise<DataEnvelope<MfaVerifiedResponseDto>> {
    // Duplicated from `auth.controller.ts`'s private `setSessionCookies` rather than exported
    // from it, so this task adds no API to a done task's file. Both build from the same
    // `CookieDefinition`s, which is where the attributes actually live.
    response.append('Set-Cookie', buildSetCookie(ACCESS_COOKIE, result.session.accessToken));
    response.append('Set-Cookie', buildSetCookie(REFRESH_COOKIE, result.session.refreshToken));
    response.append('Set-Cookie', buildSetCookie(CSRF_COOKIE, result.session.csrfToken));
    response.append('Set-Cookie', buildClearCookie(MFA_PENDING_COOKIE));

    // T-018 — this is the moment a `super_admin` session comes into existence, so this is where
    // its transport key is derived. See point 4 in this file's header.
    await establishTransportKey(this.transport, request, response, result.session.sessionId);

    return envelope(toVerifiedResponse(result));
  }
}

/**
 * The pending token: body first (02-SECURITY.md §2a's literal shape), cookie second (what a
 * browser actually sends — see `mfa.constants.ts`).
 *
 * An absent token becomes the empty string rather than `null`, so the service has one code path:
 * `MfaPendingTokenService.verify('')` returns `null` like any other unverifiable input, and the
 * caller gets the same `AUTH_SESSION_INVALID` as for an expired one. "You sent no token" and
 * "you sent a bad token" are not distinctions worth making to an anonymous caller.
 */
function pendingTokenFrom(fromBody: string | undefined, request: Request): string {
  if (fromBody !== undefined && fromBody.length > 0) return fromBody;
  return readCookie(request.headers.cookie, MFA_PENDING_COOKIE.name) ?? '';
}
