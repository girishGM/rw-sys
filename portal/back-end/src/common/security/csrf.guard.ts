/**
 * T-012 — the double-submit CSRF check (02-SECURITY.md §4, implementation note 3).
 *
 * ---
 *
 * ### What defends what
 *
 * `SameSite=Strict` on all three cookies is the primary defence and it is strong: a cross-site
 * request carries none of them, so it arrives with no session at all and is answered 401 by the
 * auth chain regardless of anything in this file. This guard is the defence in depth for the
 * cases `SameSite` does not cover cleanly — a same-site attacker on a sibling subdomain, a
 * browser that treats `Strict` loosely on a top-level navigation, a future cookie whose
 * `SameSite` gets relaxed for an unrelated reason.
 *
 * That framing matters when reading the fallbacks below: this guard is allowed to be
 * conservative, but it must never be the *only* thing standing between a cross-site request and
 * a mutation, and it never is.
 *
 * ### The expected value, in order of preference
 *
 * **1. Session-bound (the real check).** When the request carries a verified access token, the
 * expected value is `TokenService.csrfTokenFor(sid)` — an HMAC of the session id under a key
 * only this process holds. Note what the client's `rs_csrf` *cookie* contributes here:
 * nothing. It is not read, not compared, not trusted. That is what makes this resistant to the
 * attack plain double-submit is weak against — an attacker who can *set* a cookie on a sibling
 * subdomain can forge a matching cookie/header pair, but cannot forge an HMAC of a session id
 * they do not hold the key for.
 *
 * **2. Cookie-bound (public routes with a session-less credential).** `POST /auth/refresh` is
 * `@Public()` and its whole purpose is to be called when the access token has expired — so
 * there is frequently no verified session to derive an expected value from, while the request
 * does carry ambient authority in the refresh cookie. Rather than exempt it, the guard falls
 * back to classic double-submit against `rs_csrf`. This is strictly weaker than case 1 and
 * strictly stronger than nothing; it is only ever reached where case 1 is impossible.
 *
 * **3. No credential material at all → pass.** `POST /auth/login` from a browser that has never
 * seen this site has no cookie, no session and no CSRF value; requiring a header would make
 * logging in impossible. A request in this state carries no ambient authority whatsoever — there
 * is nothing for a cross-site caller to abuse, which is the entire premise of CSRF. It proceeds
 * to the auth chain, which rejects it if it needed a session.
 *
 * Note the ordering property that makes this safe: a request that *has* a session can never
 * reach case 2 or 3, and a request that has a CSRF cookie can never reach case 3. Weakening is
 * only ever the consequence of the client having less to prove with, never of the client
 * choosing to send less.
 *
 * ### The comparison
 *
 * `crypto.timingSafeEqual`, never `===` (TC-11). It throws on unequal lengths, so the length is
 * compared first — and a length mismatch is a mismatch, decided before any byte comparison
 * happens, which is where the classic implementation of this control gets it wrong.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { CSRF_COOKIE, readCookie } from '@/modules/auth/auth.cookies';
import { TokenService } from '@/modules/auth/services/token.service';
import { CHAIN_SPAN, traceSpan } from '@/common/tracing/span.service';
import { resolveVerifiedIdentity } from './request-identity';
import { CSRF_EXEMPT_METHODS, CSRF_HEADER_NAME } from './security.constants';
import {
  CsrfTokenInvalidHttpException,
  CsrfTokenMissingHttpException,
} from './security.exceptions';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  /**
   * T-019 added the span wrapper and nothing else — the decision is unchanged, in `verify`.
   *
   * 08-OBSERVABILITY.md §5 puts `csrf.verify` at the top of the per-request waterfall, and
   * `traceSpan` is a no-op outside a request, so this guard behaves identically in every test
   * that never establishes a trace. See `span.service.ts` for why the instrumentation is a free
   * function rather than an injected `SpanService`.
   */
  canActivate(context: ExecutionContext): boolean {
    return traceSpan(CHAIN_SPAN.CSRF_VERIFY, () => this.verify(context));
  }

  private verify(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // GET/HEAD/OPTIONS are exempt — and *because* they are, no GET handler may mutate state
    // (02-SECURITY.md §4). That rule is not enforceable from here; it is enforced by the route
    // inventory scan in `hardening.e2e-spec.ts` (TC-18), which fails the build if a `@Get()`
    // handler is named like a mutation.
    if (CSRF_EXEMPT_METHODS.includes(request.method.toUpperCase())) return true;

    const expected = this.expectedToken(request);
    // Case 3: no session and no CSRF cookie — nothing to check, nothing to abuse.
    if (expected === null) return true;

    const presented = request.headers[CSRF_HEADER_NAME];
    if (typeof presented !== 'string' || presented.length === 0) {
      throw new CsrfTokenMissingHttpException();
    }

    if (!constantTimeEquals(presented, expected)) {
      throw new CsrfTokenInvalidHttpException();
    }

    return true;
  }

  /** Case 1, then case 2, then case 3 — see the file header. */
  private expectedToken(request: Request): string | null {
    const identity = resolveVerifiedIdentity(request, this.tokens);
    if (identity !== null) return this.tokens.csrfTokenFor(identity.sessionId);

    return readCookie(request.headers.cookie, CSRF_COOKIE.name);
  }
}

/**
 * Length-checked `timingSafeEqual`.
 *
 * The length check is not itself constant-time and does not need to be: the length of the CSRF
 * token is a fixed, public property of this system (a 128-bit HMAC prefix, base64url), so an
 * attacker learns nothing from it that reading this file would not also tell them. What the
 * check buys is that `timingSafeEqual` — which throws a `RangeError` on unequal lengths, and
 * would therefore turn a wrong-length header into a 500 — is only ever called on equal-length
 * buffers.
 *
 * Exported so TC-11 can assert the comparison directly rather than inferring it from behaviour.
 */
export function constantTimeEquals(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}
