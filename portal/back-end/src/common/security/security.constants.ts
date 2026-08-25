/**
 * T-012 — every tunable number, header value and literal the HTTP hardening layer depends on,
 * in one place, exactly as `auth.constants.ts` and `session.constants.ts` do for T-010 and
 * T-011. A reviewer should be able to check the whole transport policy against
 * [02-SECURITY.md](../../../../project-plan/02-SECURITY.md) §4, §7 and §8 without reading five
 * middlewares.
 *
 * **Nothing here is a secret** (R4). Header values, rate-limit thresholds and window lengths
 * are all public protocol facts — they are visible in every response and derivable by anyone
 * with a browser and a loop. The only secret this layer touches is the CSRF HMAC key, which is
 * derived inside `TokenService` from the RS256 private key and never appears in this file.
 *
 * This file is an addition to T-012's declared *Files owned* list, mirroring the precedent
 * T-010 set with `auth.errors.ts` and T-011 with `session.constants.ts`. Recorded as a
 * deviation in the completion report.
 */

// --- Content Security Policy (02-SECURITY.md §7) ---------------------------------------------

/**
 * The CSP directive set, quoted from 02-SECURITY.md §7's helmet block.
 *
 * `script-src` is `'self'` and nothing else. **Neither of the two unsafe-* source expressions
 * may ever be added to it** — T-012's Definition of Done says in as many words that "a CSP that
 * only passes because it was widened is a failed task". If the Vite production build ever emits
 * an inline bootstrap script, the fix is in the build (`build.modulePreload`, or a per-response
 * nonce), not here. `security.middleware.spec.ts` asserts the absence of both by name, so
 * widening this breaks a test rather than quietly shipping.
 *
 * Those two token strings are deliberately written down **only in the test that forbids them**
 * (`test/security/support/csp-tokens.ts`), never anywhere under `src`, so that T-012
 * verification step 6 — which greps `back-end/src` for them — stays a meaningful check with a
 * genuinely empty result rather than one a reviewer has to read past every time.
 *
 * `connectSrc` takes the API origin as its one addition, because the SPA is served from a
 * different origin to the API in every deployment that is not local. When `API_ORIGIN` is
 * unset the directive collapses to `'self'`, which is the tighter of the two — an unset
 * value can only ever narrow this policy, never widen it.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'default-src': Object.freeze(["'self'"]),
  'script-src': Object.freeze(["'self'"]),
  'style-src': Object.freeze(["'self'"]),
  'img-src': Object.freeze(["'self'", 'data:']),
  'connect-src': Object.freeze(["'self'"]),
  'frame-ancestors': Object.freeze(["'none'"]),
  'object-src': Object.freeze(["'none'"]),
  'base-uri': Object.freeze(["'self'"]),
  'form-action': Object.freeze(["'self'"]),
  'upgrade-insecure-requests': Object.freeze([]),
});

// --- Other response headers (02-SECURITY.md §7) ----------------------------------------------

/** One year, `includeSubDomains`, `preload` — the values §7's helmet block specifies. */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;
export const HSTS_HEADER_VALUE = `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`;

export const REFERRER_POLICY = 'strict-origin-when-cross-origin';
/** `frameguard: { action: 'deny' }`. Legacy twin of `frame-ancestors 'none'`, kept for old UAs. */
export const FRAME_OPTIONS = 'DENY';
/** `noSniff: true`. */
export const CONTENT_TYPE_OPTIONS = 'nosniff';

// --- CORS (02-SECURITY.md §7) -----------------------------------------------------------------

/**
 * The methods and headers a browser may use cross-origin.
 *
 * `X-CSRF-Token` is on the request list because the double-submit header is a custom header:
 * without it here, every mutating cross-origin call fails preflight. Nothing is on the
 * *exposed* list — the SPA reads no response header, so exposing one would be a gratuitous
 * widening. `Set-Cookie` is never exposable to script by any CORS configuration, which is the
 * point of `httpOnly`.
 */
export const CORS_ALLOWED_METHODS: readonly string[] = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export const CORS_ALLOWED_HEADERS: readonly string[] = Object.freeze([
  'Content-Type',
  'Accept',
  'X-CSRF-Token',
  'X-Correlation-Id',
]);

/** How long a browser may cache a preflight. 10 minutes: short enough that an allowlist
 * change takes effect quickly, long enough to keep preflight noise off the hot path. */
export const CORS_MAX_AGE_SECONDS = 600;

// --- Request shape (02-SECURITY.md §6, T-012 implementation note 6) ---------------------------

/** 1 MB, on `json` and `urlencoded` alike. Anything larger is answered 413 by the parser. */
export const BODY_LIMIT = '1mb';

// --- Rate limiting (02-SECURITY.md §8) ---------------------------------------------------------

export const ONE_MINUTE_MS = 60_000;
export const FIFTEEN_MINUTES_MS = 15 * ONE_MINUTE_MS;
export const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

/** `POST /auth/login` per email+IP — the anti-brute-force limit for one targeted account. */
export const LOGIN_PER_EMAIL_IP_LIMIT = 5;
/** `POST /auth/login` per IP — the anti-enumeration limit across many accounts. */
export const LOGIN_PER_IP_LIMIT = 20;
/** `POST /auth/mfa/verify` per IP (02-SECURITY.md §2a). Consumed by T-055's route. */
export const MFA_VERIFY_PER_IP_LIMIT = 5;
/**
 * `POST /auth/mfa/verify` and `/auth/mfa/recover` per `MFA_PENDING` token, added by T-055
 * (implementation note 7: *"rate-limited (5/15 min per `mfaPendingToken`)"*).
 *
 * **Not a duplicate of the per-IP limit above.** That one bounds one source address across every
 * challenge; this one bounds one challenge across every source address, which is the shape a
 * distributed guess at a 6-digit code actually takes. A code is one in a million and lives for 90
 * seconds — five attempts per challenge is the difference between "not guessable" and "guessable
 * from a botnet".
 */
export const MFA_PER_PENDING_TOKEN_LIMIT = 5;
/** `POST /auth/forgot-password` per email. */
export const FORGOT_PASSWORD_PER_EMAIL_LIMIT = 3;
/** `POST /auth/refresh` per session. */
export const REFRESH_PER_SESSION_LIMIT = 30;
/** Authenticated API per user, per minute. */
export const AUTHENTICATED_API_LIMIT = 300;
/** Unauthenticated API per IP, per minute. */
export const UNAUTHENTICATED_API_LIMIT = 60;

/**
 * The global, **unkeyed** `/auth/login` throughput ceiling (02-SECURITY.md §8, AR-12, T-012
 * implementation note 9). Attempts beyond it are shed with 503 before Argon2 runs.
 *
 * ### What this is for, and what it is not for
 *
 * It is *not* a brute-force control — `LOGIN_PER_EMAIL_IP_LIMIT` and `LOGIN_PER_IP_LIMIT`
 * already bound what one attacker can try against one account or from one address, and they
 * remain the correct controls for that. This one exists because Argon2id verify runs on
 * **every** login attempt, including attempts for addresses that match no account (§2, and
 * `auth.constants.ts`'s own note on `ARGON2_OPTIONS`) — deliberately, to close the enumeration
 * timing channel, and unavoidably at a real CPU and memory cost per attempt. A distributed
 * attacker spreading attempts thinly across thousands of source IPs stays under every per-key
 * threshold and is bounded by neither. That is a capacity problem, not a credential problem.
 *
 * ### How the number was derived
 *
 * Measured on the reference machine (Apple M1 Pro, 10 cores, 32 GiB), using the project's own
 * `ARGON2_OPTIONS` (`argon2id`, m=19456 KiB, t=2, p=1): **25.2 ms per verify**, i.e. ~39.7
 * verifies/second on one thread, at 19 MiB of working memory each. `node-argon2` hashes on the
 * libuv threadpool, which defaults to **4** threads and is shared with file I/O and DNS — so
 * saturating it with password hashing stalls the rest of the process, not just logins.
 *
 * Budget chosen: login hashing may consume at most **~half of one** of those four threads
 * sustained — 20 verifies/second, ≈12.5% of the default pool, ≈380 MiB peak transient Argon2
 * memory. That is `20 × 60 = 1200` per one-minute window.
 *
 * For scale: 1200/minute is 240× the aggregate a single attacker can reach through the per-key
 * limits, and far above any credible legitimate peak for an internal admin portal — a Monday
 * morning burst is hundreds of logins per *hour*, not per minute. A legitimate request shed at
 * this ceiling gets a 503 with `Retry-After`, not a lockout, so the cost of being wrong on the
 * low side is one retry.
 *
 * **Provisional pending T-053.** The task file requires this to be sized from a real load test;
 * T-053 has not run yet (Wave 4). The measurement above is a real one and is reproducible, but
 * it is a single-machine microbenchmark, not a load test of the deployed topology. T-053 must
 * re-derive this number against production-shaped hardware and instance count, and is free to
 * raise it — see the completion report.
 *
 * **Per instance, unless Redis is configured.** With the in-memory store this ceiling applies
 * to each process independently, so N instances admit N × this. That is exactly the
 * "N-times weaker limiter" `THROTTLE_MULTI_INSTANCE_WARNING` warns about at boot.
 */
export const LOGIN_GLOBAL_CEILING_PER_MINUTE = 1200;

// --- The login-ceiling test override (T-066) ---------------------------------------------------

/**
 * The two `/auth/login` ceilings, resolved. Every other rule in `throttler.config.ts` reads its
 * limit straight from the constants above and is deliberately **not** overridable — see
 * {@link resolveLoginThrottleLimits} for why this is the only knob.
 */
export interface LoginThrottleLimits {
  readonly perEmailIp: number;
  readonly perIp: number;
  readonly windowMs: number;
  /** True only when a valid override is actually in force. Drives the boot log, nothing else. */
  readonly relaxed: boolean;
  /** The multiplier actually applied, after clamping. Always exactly 1 when `relaxed` is false. */
  readonly factor: number;
}

/**
 * The production policy, verbatim from 02-SECURITY.md §8's table. This is what
 * {@link resolveLoginThrottleLimits} returns for every input except a valid override outside
 * production, and what `resolveThrottlePolicy` uses when nobody passes it anything at all.
 */
export const PRODUCTION_LOGIN_THROTTLE_LIMITS: LoginThrottleLimits = Object.freeze({
  perEmailIp: LOGIN_PER_EMAIL_IP_LIMIT,
  perIp: LOGIN_PER_IP_LIMIT,
  windowMs: FIFTEEN_MINUTES_MS,
  relaxed: false,
  factor: 1,
});

/** The environment variable name, in one place so the schema, the docs and the tests agree. */
export const LOGIN_THROTTLE_RELAX_FACTOR_VAR = 'LOGIN_THROTTLE_RELAX_FACTOR';

/**
 * DI token for the resolved {@link LoginThrottleLimits}. `SecurityModule` provides it from the
 * config layer; `RateLimitGuard` injects it optionally and falls back to the production numbers.
 */
export const LOGIN_THROTTLE_LIMITS = Symbol('LOGIN_THROTTLE_LIMITS');

/**
 * The largest multiplier that will be honoured.
 *
 * The cap is the difference between "relaxed" and "off". Without it, `LOGIN_THROTTLE_RELAX_FACTOR
 * =1000000` in a test environment is an unlimited login endpoint, and the failure mode of this
 * whole feature becomes the thing it was supposed to avoid. 40 takes the per-email+IP ceiling to
 * 200 and the per-IP ceiling to 800 per 15 minutes — comfortably more than a full e2e run needs
 * (T-050 drives well under a hundred logins for one account), and still a real limit that a
 * genuine brute-force loop would trip in seconds. A value above the cap is clamped to it, not
 * rejected: the operator's intent ("higher") is honoured, the unbounded reading is not.
 */
export const MAX_LOGIN_THROTTLE_RELAX_FACTOR = 40;

/** Logged, at warn level, on every boot where the override is actually in force (TC-6). */
export function loginThrottleRelaxedWarning(limits: LoginThrottleLimits): string {
  return (
    `SECURITY: login rate limits are RELAXED by ${LOGIN_THROTTLE_RELAX_FACTOR_VAR}=${limits.factor}. ` +
    `login_per_email_ip=${limits.perEmailIp} (production ${LOGIN_PER_EMAIL_IP_LIMIT}), ` +
    `login_per_ip=${limits.perIp} (production ${LOGIN_PER_IP_LIMIT}), ` +
    `window=${limits.windowMs / ONE_MINUTE_MS} min. ` +
    'This is intended for automated test environments only and is ignored when ' +
    'NODE_ENV=production. If you are seeing this in a deployed environment, unset the variable.'
  );
}

/**
 * Resolves the login ceilings from configuration (T-066).
 *
 * ### Why an override exists at all
 *
 * The production numbers are correct and are not what this changes. A full e2e run drives more
 * real logins against one shared account from one address than 5-per-15-minutes allows, so the
 * suite throttled itself — not because the limiter was wrong, but because nothing could opt a
 * test environment into different values. The default here **is** the production value; this
 * function's entire job is to refuse the override in every case except the one it was built for.
 *
 * ### Why one multiplier rather than a dial per rule
 *
 * The need is "raise the login ceilings", so there is one knob and it moves exactly the two
 * ceilings that blocked the suite. The window is deliberately **not** adjustable, and neither are
 * the MFA, refresh, forgot-password or general-API limits: an override that can reshape the whole
 * §8 table is a much larger hole than the one it closes, and nothing needs it. A multiplier also
 * cannot express "unlimited" the way an absolute value can — the worst a caller can do is
 * {@link MAX_LOGIN_THROTTLE_RELAX_FACTOR}.
 *
 * ### Every rejection path returns the production numbers
 *
 * Unset, empty, non-numeric, negative, zero, one, fractional, `Infinity`, or *any* value at all
 * while `NODE_ENV=production` — all of them yield {@link PRODUCTION_LOGIN_THROTTLE_LIMITS}. There
 * is no input that produces a weaker-than-production limit and no input that produces an
 * unbounded one. Note that this fails *safe*, not *fast*: garbage degrades to the production
 * policy rather than stopping the boot, matching `LOG_LEVEL`'s documented trade in
 * `env.schema.ts` — a typo in a test-environment convenience knob must never be able to keep the
 * application from starting.
 */
export function resolveLoginThrottleLimits(input: {
  readonly raw: string | undefined | null;
  readonly nodeEnv: string | undefined | null;
}): LoginThrottleLimits {
  // Gate 1: production ignores the variable outright, whatever it says (TC-4). Checked before
  // the value is even parsed, so there is no ordering in which a production process consults it.
  if (input.nodeEnv === 'production') return PRODUCTION_LOGIN_THROTTLE_LIMITS;

  const factor = parseRelaxFactor(input.raw);
  if (factor === null) return PRODUCTION_LOGIN_THROTTLE_LIMITS;

  return Object.freeze({
    perEmailIp: LOGIN_PER_EMAIL_IP_LIMIT * factor,
    perIp: LOGIN_PER_IP_LIMIT * factor,
    // Unchanged on purpose — see this function's header.
    windowMs: FIFTEEN_MINUTES_MS,
    relaxed: true,
    factor,
  });
}

/**
 * Parses the multiplier, returning `null` for anything that is not a whole number ≥ 2.
 *
 * Strict digits-only matching rather than `Number()`/`parseInt`, because both are too permissive
 * to be safe here: `parseInt('5x')` is 5, `Number('')` and `Number(' ')` are 0, `Number('1e9')` is
 * a billion, and `parseInt('0x10')` is 16. A rate-limit multiplier read from an environment
 * variable is exactly the wrong place for that kind of helpfulness. Values below 2 are rejected
 * as `null` rather than clamped to 1: a factor of 1 is a no-op and 0 or -1 are attempts to say
 * something this knob cannot say, and all three deserve the production default plus silence.
 */
function parseRelaxFactor(raw: string | undefined | null): number | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 2) return null;

  return Math.min(parsed, MAX_LOGIN_THROTTLE_RELAX_FACTOR);
}

/**
 * Upper bound on distinct keys the in-memory store will hold.
 *
 * Without a cap, the per-IP counters are an unauthenticated memory-growth vector: every forged
 * source address mints a map entry that lives for the length of its window. Expired entries are
 * swept first; if the store is still at the cap, the entries closest to expiry are evicted.
 * Eviction can only ever *forget* that somebody was rate-limited, never invent a limit, so the
 * failure mode under key flooding is degraded limiting — the same posture as a Redis outage on
 * a non-auth route — rather than an out-of-memory kill that takes the whole API down.
 */
export const THROTTLE_MEMORY_MAX_KEYS = 100_000;

/** Logged at boot when several instances are configured with no shared store. */
export const THROTTLE_MULTI_INSTANCE_WARNING =
  'Rate limiting is using the in-memory store while APP_INSTANCE_COUNT > 1. ' +
  'An in-memory limiter across N instances is an N-times weaker limiter (02-SECURITY.md §8). ' +
  'Set REDIS_URL to share counters between instances.';

// --- Response codes (03-API-CONTRACT.md §1) ----------------------------------------------------

/**
 * The API returns a **code**, never a sentence — the SPA looks the wording up in
 * `system_messages`, exactly as `AUTH_ERROR_CODE` documents for T-011.
 *
 * None of these four keys is seeded yet: `system_messages` rows are T-004's migration and
 * T-014 owns `common/messages/**`. Flagged in the completion report as a follow-up rather than
 * worked around here, because writing a seed migration for another task's table is precisely
 * what R9 forbids.
 */
export const SECURITY_ERROR_CODE = Object.freeze({
  /** Mutating request with no `X-CSRF-Token` header at all (TC-7). */
  CSRF_TOKEN_MISSING: 'CSRF_TOKEN_MISSING',
  /** Header present but not equal to the session-bound value (TC-8). */
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',
  /**
   * Any rate limit. Deliberately one code for all seven limits: TC-15 requires the 429 to
   * disclose neither which limit tripped nor how much quota is left, and a per-limit code
   * would hand an attacker exactly that map.
   */
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * Load shed: the global login ceiling, or a fail-closed auth route whose counter store is
   * unreachable. One code for both, for the same reason — the client's correct reaction is
   * identical (wait and retry), and distinguishing them would tell a caller probing the login
   * path whether the rate limiter's backing store is down.
   */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** Request body over {@link BODY_LIMIT} (TC-16). */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /** Body that is not parseable JSON. Shaped here so the parser's own HTML page never ships. */
  MALFORMED_BODY: 'MALFORMED_BODY',
});

/** `Retry-After` on a shed request, in seconds. Short: the ceiling is a burst control. */
export const SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// --- Method policy (02-SECURITY.md §4) ---------------------------------------------------------

/**
 * The methods `CsrfGuard` exempts. Everything else — including any method not listed here at
 * all — requires the header, so the guard fails closed on a verb nobody anticipated.
 */
export const CSRF_EXEMPT_METHODS: readonly string[] = Object.freeze(['GET', 'HEAD', 'OPTIONS']);

/** The `X-CSRF-Token` header name, mirrored from the `rs_csrf` cookie by the SPA. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Handler-name prefixes that must never appear on a `@Get()` route (T-012 implementation note
 * 4, TC-18). GET is CSRF-exempt, so a mutating GET is a CSRF hole regardless of how carefully
 * the rest of this file is written. A cheap heuristic that catches the real mistake.
 */
export const MUTATING_HANDLER_PREFIXES: readonly string[] = Object.freeze([
  'create',
  'update',
  'delete',
  'submit',
  'approve',
  'reject',
  'revoke',
]);
