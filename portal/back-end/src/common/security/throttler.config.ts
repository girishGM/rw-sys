/**
 * T-012 — the rate-limit policy: which counters a request is charged against, and what happens
 * when the store that holds them is unreachable (02-SECURITY.md §8, AR-11, AR-12).
 *
 * ---
 *
 * ### The table, verbatim from §8
 *
 * | Scope | Limit | Window | On store outage |
 * |---|---|---|---|
 * | `POST /auth/login` per email+IP | 5 | 15 min | **fail closed** | ← T-066 may raise, see below
 * | `POST /auth/login` per IP | 20 | 15 min | **fail closed** | ← T-066 may raise, see below
 * | `POST /auth/login` global aggregate | 1200 | 1 min | **fail closed** |
 * | `POST /auth/mfa/verify` per IP | 5 | 15 min | **fail closed** |
 * | `POST /auth/mfa/{verify,recover}` per pending token | 5 | 15 min | as the route | ← T-055
 * | `POST /auth/forgot-password` per email | 3 | 1 hour | fail open |
 * | `POST /auth/refresh` per session | 30 | 15 min | **fail closed** |
 * | Authenticated API per user | 300 | 1 min | fail open |
 * | Unauthenticated API per IP | 60 | 1 min | fail open |
 *
 * ### Two things about how the rules compose
 *
 * **Every request is charged against the general bucket, plus any route-specific rules.** The
 * alternative — route-specific rules *instead of* the general one — leaves holes that are only
 * obvious in hindsight: `/auth/forgot-password` is limited to 3 per hour *per email*, so a
 * caller cycling through a million addresses would be bounded by nothing at all. Composing them
 * means every route has a per-IP or per-user ceiling underneath whatever else applies to it.
 *
 * **Every applicable rule is charged, even after one has already tripped.** A request that
 * exceeds its per-email limit still increments the per-IP counter. Not doing so would let an
 * attacker keep the coarser counters artificially low by deliberately tripping a fine-grained
 * one first.
 *
 * ### The asymmetry (AR-11), stated where it is implemented
 *
 * `failClosed` is a property of the *route*, not a global setting, which is what T-012
 * implementation note 8 asks for: "so the asymmetry is visible in the code". On `/auth/login`,
 * `/auth/mfa/verify` and `/auth/refresh` an unreachable counter store produces 503 and the
 * request never reaches Argon2. Everywhere else it produces a warning and the request proceeds.
 *
 * The reasoning is worth keeping next to the flag: an outage on a general API route degrades
 * the product for people who are already authenticated. An outage on the login route, if it
 * failed open, would silently convert the single most attacked endpoint in the system into an
 * unthrottled credential-stuffing and CPU-exhaustion surface, at the exact moment nobody is
 * watching dashboards because Redis is down.
 *
 * ### The two login rows are configurable; the other seven are not (T-066)
 *
 * The numbers in the first two rows are the **defaults**, not literals: `resolveThrottlePolicy`
 * takes a {@link LoginThrottleLimits} whose default is
 * {@link PRODUCTION_LOGIN_THROTTLE_LIMITS} — i.e. exactly the table above. A test environment can
 * multiply those two ceilings via `LOGIN_THROTTLE_RELAX_FACTOR`, because a full e2e run drives
 * more real logins against one account from one address than 5-per-15-minutes allows and was
 * throttling itself. Every guard on that override lives in `resolveLoginThrottleLimits`: it is
 * ignored under `NODE_ENV=production`, clamped so it cannot mean "unlimited", and falls back to
 * the production numbers on any input it does not fully understand.
 *
 * Nothing else here is overridable, deliberately. The global login ceiling stays at 1200/min —
 * it is a capacity control on Argon2, not a per-attacker one, and no test run approaches it — and
 * the MFA, refresh, forgot-password and general API rows are untouched.
 */
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { LOGIN_ATTEMPT_EMAIL_MAX_LENGTH } from '@/modules/auth/auth.constants';
import { REFRESH_COOKIE, readCookie } from '@/modules/auth/auth.cookies';
import { MFA_PENDING_COOKIE, MFA_PENDING_TOKEN_MAX_LENGTH } from '@/modules/auth/mfa.constants';
import type { VerifiedIdentity } from './request-identity';
import {
  AUTHENTICATED_API_LIMIT,
  FIFTEEN_MINUTES_MS,
  FORGOT_PASSWORD_PER_EMAIL_LIMIT,
  LOGIN_GLOBAL_CEILING_PER_MINUTE,
  MFA_PER_PENDING_TOKEN_LIMIT,
  MFA_VERIFY_PER_IP_LIMIT,
  ONE_HOUR_MS,
  ONE_MINUTE_MS,
  PRODUCTION_LOGIN_THROTTLE_LIMITS,
  REFRESH_PER_SESSION_LIMIT,
  UNAUTHENTICATED_API_LIMIT,
  type LoginThrottleLimits,
} from './security.constants';

/** How a tripped rule is answered. Never disclosed to the client — see TC-15. */
export type ShedMode = 'rate_limited' | 'service_unavailable';

/** One counter a request may be charged against. */
export interface ThrottleRule {
  /**
   * Server-side identifier, used in the counter key and in the log line. **Never** appears in a
   * response: knowing which of seven limits tripped is exactly the map TC-15 denies an attacker.
   */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly key: string;
  readonly shedWith: ShedMode;
}

/** The complete policy for one request. */
export interface ThrottlePolicy {
  readonly rules: readonly ThrottleRule[];
  /** True on the three auth routes AR-11 names. See this file's header. */
  readonly failClosed: boolean;
}

/** Everything rule keys are derived from. All of it transport-level; none of it authorisation. */
export interface ThrottleContext {
  readonly method: string;
  /** Path with the global API prefix already stripped, lowercased, no trailing slash. */
  readonly route: string;
  readonly ip: string;
  /** From the verified access token, or `null` for an anonymous request. */
  readonly identity: VerifiedIdentity | null;
  /** `email` from the request body, if the body has one. Rate-limit key material only. */
  readonly email: string | null;
  /** SHA-256 of the presented refresh cookie, or `null`. Identifies a session without a query. */
  readonly refreshTokenHash: string | null;
  /**
   * SHA-256 of the presented `MFA_PENDING` cookie or body field, or `null` (T-055).
   *
   * A *digest*, never the token: a rate-limit key reaches Redis, `MONITOR` output and slow-query
   * logs, and the token itself is a live credential for five minutes. Same reasoning as
   * {@link refreshTokenHash} — see {@link hashKeyMaterial}.
   */
  readonly pendingTokenHash: string | null;
}

/**
 * The API's global prefix, as `main.ts` sets it. Kept here as its own constant so the coupling
 * is greppable: changing `setGlobalPrefix` requires changing this too.
 *
 * T-058 removed the other half of that coupling — `session.constants.ts` used to hard-code this
 * prefix into a refresh-cookie `Path`, which is why this comment once named it. Cookie paths are
 * now all `/` (the `__Host-` prefix requires it), so route prefixes and cookie paths are no
 * longer linked at all.
 */
export const API_PREFIX = '/api/v1';

/** Routes (post-prefix) that are not rate limited at all. */
const UNTHROTTLED_ROUTES: readonly string[] = Object.freeze([
  // Liveness. A constant-string response that touches nothing, polled every few seconds by
  // every orchestrator there is — throttling it would turn a monitoring probe into a false
  // outage while protecting nothing (03-API-CONTRACT.md §14).
  '/health',
]);

const LOGIN_ROUTE = '/auth/login';
const MFA_VERIFY_ROUTE = '/auth/mfa/verify';
const MFA_RECOVER_ROUTE = '/auth/mfa/recover';
const REFRESH_ROUTE = '/auth/refresh';
const FORGOT_PASSWORD_ROUTE = '/auth/forgot-password';

/**
 * The two routes that consume an `MFA_PENDING` token, and are therefore brute-forceable against
 * one (T-055 implementation note 7). `/auth/mfa/enrol` is deliberately absent: it consumes a
 * pending token but there is nothing to guess there — it mints a seed rather than checking one.
 */
const MFA_CHALLENGE_ROUTES: readonly string[] = Object.freeze([
  MFA_VERIFY_ROUTE,
  MFA_RECOVER_ROUTE,
]);

/** The three routes AR-11 requires to fail closed when the counter store is unreachable. */
export const FAIL_CLOSED_ROUTES: readonly string[] = Object.freeze([
  LOGIN_ROUTE,
  MFA_VERIFY_ROUTE,
  REFRESH_ROUTE,
]);

/**
 * Normalises a request path for matching: query stripped, global prefix removed, lowercased,
 * trailing slash removed.
 *
 * Path matching is exact, never `startsWith`. A prefix match would mean `/auth/login-attempts`
 * (or anything else a later task adds under that path) silently inherits the login policy — or,
 * worse, that a route could be crafted to *avoid* one.
 */
export function normaliseRoute(path: string): string {
  const withoutQuery = path.split('?')[0].toLowerCase();
  const withoutPrefix = withoutQuery.startsWith(API_PREFIX)
    ? withoutQuery.slice(API_PREFIX.length)
    : withoutQuery;
  const trimmed = withoutPrefix.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

/**
 * Hashes key material.
 *
 * Two reasons, neither cosmetic. Counter keys reach Redis, where they appear in `MONITOR`
 * output, in slow-query logs and in any operational dump — an email address in a rate-limit key
 * is PII sitting in an unexpected place, and 02-SECURITY.md §9's logging rule exists precisely
 * because those places get forgotten. And a hash bounds the key length, so a caller cannot
 * inflate memory or a Redis key namespace by sending a 200-character address.
 *
 * 128 bits of the digest: collision-resistant enough for a counter namespace, half the bytes.
 */
function hashKeyMaterial(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

/** Builds the context a policy is resolved from. Pure, so it is directly testable. */
export function buildThrottleContext(
  request: Request,
  identity: VerifiedIdentity | null,
): ThrottleContext {
  const presentedRefresh = readCookie(request.headers.cookie, REFRESH_COOKIE.name);
  // T-055: the pending token arrives in the cookie the login response set, or in the body for a
  // client following 02-SECURITY.md §2a literally. Both are read here so a caller cannot pick the
  // transport that misses the counter.
  const presentedPending =
    extractPendingToken(request.body) ??
    readCookie(request.headers.cookie, MFA_PENDING_COOKIE.name);

  return {
    method: request.method.toUpperCase(),
    route: normaliseRoute(request.path),
    // `request.ip` honours `trust proxy`, which `security.middleware.ts` configures from an
    // allowlist and never from `true`. An address is unavailable only on a request that never
    // reached a socket, which cannot happen in the HTTP server but can in a unit test.
    ip: request.ip ?? 'unknown',
    identity,
    email: extractEmail(request.body),
    refreshTokenHash: presentedRefresh === null ? null : hashKeyMaterial(presentedRefresh),
    pendingTokenHash: presentedPending === null ? null : hashKeyMaterial(presentedPending),
  };
}

/**
 * Reads `mfaPendingToken` out of an already-parsed body, defensively — the same shape and the
 * same warning as {@link extractEmail}: used **only** as rate-limit key material, never as an
 * identity (R3). Truncated, so an oversized string cannot bloat the key space; the value is
 * hashed immediately afterwards in any case.
 */
function extractPendingToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { mfaPendingToken?: unknown }).mfaPendingToken;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim().slice(0, MFA_PENDING_TOKEN_MAX_LENGTH);
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Reads `email` out of an already-parsed body, defensively.
 *
 * This is the one place in the hardening layer that touches client-supplied data, so: it is
 * used **only** as rate-limit key material, never as an identity, never as scope (R3). Trimmed,
 * lowercased and truncated to the column width T-010 already uses, so the same address in two
 * letter-cases shares one counter and an oversized string cannot be used to bloat the key space.
 */
function extractEmail(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { email?: unknown }).email;
  if (typeof value !== 'string') return null;

  const normalised = value.trim().toLowerCase().slice(0, LOGIN_ATTEMPT_EMAIL_MAX_LENGTH);
  return normalised.length === 0 ? null : normalised;
}

/**
 * Resolves the rules a request is charged against.
 *
 * Rules are returned in evaluation order, and the order is deliberate: the global login ceiling
 * comes first so a distributed flood is shed on the cheapest possible check, before any
 * per-key counter is even touched.
 *
 * `loginLimits` (T-066) is the only configurable input, and it is a **parameter** rather than
 * something this function reads from the environment: the function stays pure and directly
 * testable, and `process.env` is never touched on the hot path. `RateLimitGuard` resolves it once
 * at construction, from the config layer, and passes the same frozen object on every request.
 * Defaulting it to the production numbers means every existing caller — and every future one that
 * forgets the second argument — gets 02-SECURITY.md §8's table, not an absent limit.
 */
export function resolveThrottlePolicy(
  context: ThrottleContext,
  loginLimits: LoginThrottleLimits = PRODUCTION_LOGIN_THROTTLE_LIMITS,
): ThrottlePolicy {
  if (UNTHROTTLED_ROUTES.includes(context.route)) {
    return { rules: [], failClosed: false };
  }

  const rules: ThrottleRule[] = [];
  const isPost = context.method === 'POST';

  if (isPost && context.route === LOGIN_ROUTE) {
    rules.push(
      {
        // AR-12. Unkeyed on purpose: one counter for the whole endpoint, which is what makes it
        // a capacity control rather than another per-attacker one.
        name: 'login_global_ceiling',
        limit: LOGIN_GLOBAL_CEILING_PER_MINUTE,
        windowMs: ONE_MINUTE_MS,
        key: 'login:global',
        shedWith: 'service_unavailable',
      },
      {
        name: 'login_per_email_ip',
        limit: loginLimits.perEmailIp,
        windowMs: loginLimits.windowMs,
        key: `login:eip:${hashKeyMaterial(`${context.email ?? ''}|${context.ip}`)}`,
        shedWith: 'rate_limited',
      },
      {
        name: 'login_per_ip',
        limit: loginLimits.perIp,
        windowMs: loginLimits.windowMs,
        key: `login:ip:${hashKeyMaterial(context.ip)}`,
        shedWith: 'rate_limited',
      },
    );
  }

  if (isPost && context.route === MFA_VERIFY_ROUTE) {
    // T-055's route. Listed here now so the limit exists the day the endpoint does, rather than
    // being a thing somebody has to remember to add to a file they have no reason to open.
    rules.push({
      name: 'mfa_verify_per_ip',
      limit: MFA_VERIFY_PER_IP_LIMIT,
      windowMs: FIFTEEN_MINUTES_MS,
      key: `mfa:ip:${hashKeyMaterial(context.ip)}`,
      shedWith: 'rate_limited',
    });
  }

  // T-055 implementation note 7 — 5 per 15 minutes **per `mfaPendingToken`**, on both routes that
  // consume one. Keyed by the presented token's digest, exactly as the refresh rule is keyed by
  // the refresh cookie's: it identifies one challenge without a database read, on a guard that
  // runs long before anything has looked a user up. A request with no pending cookie is going to
  // be rejected by the controller anyway and is left to the per-IP and general buckets.
  if (isPost && MFA_CHALLENGE_ROUTES.includes(context.route) && context.pendingTokenHash !== null) {
    rules.push({
      name: 'mfa_per_pending_token',
      limit: MFA_PER_PENDING_TOKEN_LIMIT,
      windowMs: FIFTEEN_MINUTES_MS,
      key: `mfa:tok:${context.pendingTokenHash}`,
      shedWith: 'rate_limited',
    });
  }

  if (isPost && context.route === REFRESH_ROUTE) {
    rules.push({
      name: 'refresh_per_session',
      limit: REFRESH_PER_SESSION_LIMIT,
      windowMs: FIFTEEN_MINUTES_MS,
      // Keyed by the presented token's digest, which identifies the session without a database
      // read — the guard runs long before anything has looked the session up. A request with no
      // refresh cookie is going to be rejected by the controller anyway; it falls back to the IP
      // so that a flood of cookie-less refresh attempts is still bounded.
      key:
        context.refreshTokenHash === null
          ? `refresh:ip:${hashKeyMaterial(context.ip)}`
          : `refresh:sid:${context.refreshTokenHash}`,
      shedWith: 'rate_limited',
    });
  }

  if (isPost && context.route === FORGOT_PASSWORD_ROUTE && context.email !== null) {
    rules.push({
      name: 'forgot_password_per_email',
      limit: FORGOT_PASSWORD_PER_EMAIL_LIMIT,
      windowMs: ONE_HOUR_MS,
      key: `forgot:email:${hashKeyMaterial(context.email)}`,
      shedWith: 'rate_limited',
    });
  }

  rules.push(generalRule(context));

  return { rules, failClosed: FAIL_CLOSED_ROUTES.includes(context.route) && isPost };
}

/**
 * The per-user (authenticated) or per-IP (anonymous) bucket every request is charged against.
 *
 * Keying an authenticated request by user rather than by IP is not a nicety: a whole tenant
 * behind one corporate NAT shares an address, and a per-IP quota there would let one busy user
 * lock out their colleagues.
 */
function generalRule(context: ThrottleContext): ThrottleRule {
  if (context.identity !== null) {
    return {
      name: 'authenticated_api_per_user',
      limit: AUTHENTICATED_API_LIMIT,
      windowMs: ONE_MINUTE_MS,
      key: `api:user:${context.identity.userId}`,
      shedWith: 'rate_limited',
    };
  }

  return {
    name: 'unauthenticated_api_per_ip',
    limit: UNAUTHENTICATED_API_LIMIT,
    windowMs: ONE_MINUTE_MS,
    key: `api:ip:${hashKeyMaterial(context.ip)}`,
    shedWith: 'rate_limited',
  };
}
