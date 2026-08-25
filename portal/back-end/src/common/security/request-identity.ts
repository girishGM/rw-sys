/**
 * T-012 — "who is this, as far as a *verified* token is concerned?", answered once per request
 * and shared by `CsrfGuard` and `RateLimitGuard`.
 *
 * ---
 *
 * ### Why these two guards cannot simply read `request.authUser`
 *
 * 00-ARCHITECTURE.md §6 fixes the chain: `RateLimitGuard` is 3, `CsrfGuard` is 4, `JwtAuthGuard`
 * is **5**. Both of this task's guards therefore run *before* the guard that populates
 * `request.authUser`, and both genuinely need an identity:
 *
 *  - the CSRF double-submit value is bound to the session id (02-SECURITY.md §4 —
 *    `TokenService.csrfTokenFor` explains why it is an HMAC of `sid` rather than stored state);
 *  - the "authenticated API per user" limit (§8) is keyed by user, and keying it by IP instead
 *    would let one user behind a corporate NAT exhaust everybody else's quota.
 *
 * The order in §6 is not negotiable and is not a mistake: rate limiting *must* precede token
 * verification, because verification is work an unauthenticated flood would otherwise get for
 * free. So the identity is resolved here instead, from the same cookie and through the same
 * `TokenService.verifyAccessToken` the real guard uses.
 *
 * ### Why this is not a second authentication path
 *
 * This is the part worth being careful about, so it is stated explicitly: **nothing here grants
 * access to anything.** It answers a question used only to *choose a rate-limit key* and to
 * *choose which CSRF value to expect*. `JwtAuthGuard` still runs, still re-verifies, and is
 * still the only writer of `request.authUser`; `SessionValidGuard` still checks the session is
 * alive against the database, which this function deliberately does not do. A token that is
 * expired, forged or belongs to a revoked session resolves to `null` here and the request is
 * treated as anonymous — which is the conservative direction for both callers (the stricter
 * unauthenticated IP limit, and no session-bound CSRF value to accept).
 *
 * There is exactly one verification implementation in the process, in `TokenService`, and this
 * calls it rather than reimplementing any part of it.
 *
 * ### Cached per request
 *
 * The result is memoised on the request object under a module-private symbol, so a request
 * passing through both guards verifies its token once, not twice. A symbol rather than a string
 * key so nothing else — including a future middleware and including a request body — can collide
 * with it or forge it.
 */
import type { Request } from 'express';
import { ACCESS_COOKIE, readCookie } from '@/modules/auth/auth.cookies';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { TokenService } from '@/modules/auth/services/token.service';

/** What the two guards need, and nothing else — no role, no tenant, no scope. */
export interface VerifiedIdentity {
  readonly userId: number;
  readonly sessionId: string;
}

const IDENTITY_CACHE = Symbol('rs.verifiedIdentity');

interface CachingRequest extends AuthenticatedRequest {
  [IDENTITY_CACHE]?: VerifiedIdentity | null;
}

/**
 * Resolves the caller from `request.authUser` if a previous guard has already established it,
 * otherwise from the access cookie. Returns `null` for anonymous, expired, malformed or forged.
 *
 * Never throws: every failure mode of token verification is "this request is anonymous", and a
 * guard running this far ahead of the auth chain must not be able to turn a bad cookie into a
 * 500 on a `@Public()` route.
 */
export function resolveVerifiedIdentity(
  request: Request,
  tokens: TokenService,
  now: Date = new Date(),
): VerifiedIdentity | null {
  const cachingRequest = request as CachingRequest;

  const cached = cachingRequest[IDENTITY_CACHE];
  if (cached !== undefined) return cached;

  const resolved = resolve(cachingRequest, tokens, now);
  cachingRequest[IDENTITY_CACHE] = resolved;
  return resolved;
}

function resolve(
  request: CachingRequest,
  tokens: TokenService,
  now: Date,
): VerifiedIdentity | null {
  if (request.authUser !== undefined) {
    return { userId: request.authUser.userId, sessionId: request.authUser.sessionId };
  }

  const token = readCookie(request.headers.cookie, ACCESS_COOKIE.name);
  if (token === null) return null;

  try {
    const claims = tokens.verifyAccessToken(token, now);
    return { userId: claims.userId, sessionId: claims.sessionId };
  } catch {
    // Deliberately silent: `JwtAuthGuard` logs the specific reason a few layers later, and
    // logging it twice per request would double the noise an attacker can generate.
    return null;
  }
}
