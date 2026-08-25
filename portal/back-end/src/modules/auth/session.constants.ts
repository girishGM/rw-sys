/**
 * T-011 — every tunable number, literal and enumerated value the session lifecycle depends
 * on, in one place, exactly as `auth.constants.ts` does for T-010's credential layer. A
 * reviewer should be able to check the whole token/cookie policy against
 * [02-SECURITY.md](../../../../project-plan/02-SECURITY.md) §1–3 without reading four
 * services.
 *
 * **Nothing here is a secret** (R4). The cookie names, TTLs, issuer and audience are all
 * public protocol identifiers — they appear in every response header and in every decoded
 * token. The only secrets in this module are the RS256 key pair (resolved through
 * `ConfigModule`) and the refresh/reset tokens themselves, which are generated per use and
 * never written down anywhere but as a SHA-256 digest.
 *
 * This file is an addition to T-011's declared *Files owned* list. It collides with no other
 * task's list — T-010 owns `auth.constants.ts`, T-012 owns `src/common/security/**`, T-055
 * owns the MFA files. Recorded as a deviation in the completion report.
 */

// --- Lifetimes (02-SECURITY.md §1, the token table) -----------------------------------------

/**
 * Access-token lifetime. Short by design: the JWT is self-contained, so between issuance and
 * expiry the only thing that can stop it is `SessionValidGuard`'s per-request session check.
 * Fifteen minutes is the blast radius of a leaked access token *if that check is ever
 * bypassed*; it is not the revocation latency, which is one request.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Refresh-token lifetime. Long, and only safe because of the two controls in
 * `session.service.ts`: single-use rotation, and reuse detection that revokes the whole
 * family on a replay. Lengthening this without both of those intact would be a material
 * weakening — see 02-SECURITY.md §3.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `portal_sessions.expires_at`. Deliberately identical to the refresh lifetime: a session
 * that outlived its longest-lived refresh token could never be extended and would just be a
 * row that looks active while being unusable, and one that expired sooner would kill a
 * refresh token the database still considers valid. One number, one meaning.
 */
export const SESSION_TTL_SECONDS = REFRESH_TOKEN_TTL_SECONDS;

/**
 * Password-reset token lifetime. One hour: long enough to survive a slow mail relay and a
 * distracted user, short enough that a reset link sitting in a mailbox is not a standing
 * credential. Single-use on top of this (T-011 TC-22).
 */
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

/**
 * How stale `portal_sessions.last_seen_at` is allowed to get before `SessionValidGuard`
 * writes it again. Without a floor this would be one UPDATE per request on the hot path, for
 * a column whose only consumer is the "your sessions" screen; with it, the write happens at
 * most once a minute per session and the displayed value is accurate to the minute.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

// --- JWT (02-SECURITY.md §1.1) --------------------------------------------------------------

/**
 * The **only** algorithm this system signs or accepts. Kept as a one-element allowlist rather
 * than a bare string because the array is what `TokenService.verifyAccessToken` tests
 * membership against, and "the list of algorithms we accept" is the exact thing whose absence
 * is the `alg` confusion vulnerability (T-011 TC-10/TC-11). Adding an entry here — especially
 * an HMAC one — is a security change, not a configuration change.
 */
export const JWT_ALLOWED_ALGORITHMS: readonly string[] = Object.freeze(['RS256']);

/** The algorithm tokens are signed with. Must be a member of {@link JWT_ALLOWED_ALGORITHMS}. */
export const JWT_SIGNING_ALGORITHM = 'RS256';

/**
 * `iss` and `aud`, asserted on every verification.
 *
 * **Why constants rather than environment variables.** 02-SECURITY.md §9's "no silent
 * defaults for security values" is about *secrets* — a value that must differ per deployment
 * and must not be guessable. `iss`/`aud` are neither: they are fixed identifiers of this
 * application, they travel in clear text inside every token, and their whole job is to make a
 * token minted for some *other* system fail here. A constant cannot be misconfigured to a
 * value that silently disables that check; an env var can. If a future deployment genuinely
 * needs to vary them, promote them to `env.schema.ts` with `.min(1)` and no default.
 */
export const JWT_ISSUER = 'reward-portal';
export const JWT_AUDIENCE = 'reward-portal-spa';

/**
 * Hard ceiling on the length of a token this service will even attempt to parse. A JWT for
 * this system is ~600 characters; anything approaching this is not a token that could have
 * been minted here. Bounds the work an unauthenticated caller can request on a route reachable
 * before authentication, the same reasoning as `PASSWORD_MAX_LENGTH` in `auth.constants.ts`.
 */
export const JWT_MAX_LENGTH = 8192;

/** Minimum RSA modulus accepted for the signing key pair. Below this, RS256 is not RS256. */
export const JWT_MIN_MODULUS_LENGTH = 2048;

// --- Cookies (02-SECURITY.md §1) ------------------------------------------------------------

/**
 * The `__Host-` prefix is load-bearing, not cosmetic: a browser rejects a `__Host-` cookie
 * outright unless it is `Secure`, has `Path=/` and carries **no `Domain` attribute**, which
 * forecloses subdomain cookie injection. Renaming these to drop the prefix — for instance to
 * make plain-HTTP local development easier — removes that guarantee silently, which is why
 * T-011's implementation notes forbid it explicitly.
 */
export const ACCESS_COOKIE_NAME = '__Host-rs_at';
export const REFRESH_COOKIE_NAME = '__Host-rs_rt';

/**
 * The CSRF cookie is deliberately **not** `__Host-`-prefixed and deliberately **not**
 * `httpOnly`: the SPA has to read it with JavaScript to mirror it into the `X-CSRF-Token`
 * header, which is the entire double-submit mechanism (02-SECURITY.md §4). It carries no
 * authority on its own — possessing it grants nothing; it is only ever compared against a
 * value derived from the *verified* session.
 */
export const CSRF_COOKIE_NAME = 'rs_csrf';

/**
 * `Path` for **every** cookie this module emits — access, refresh and CSRF alike.
 *
 * `/` is not a default that nobody thought about; for the two `__Host-`-prefixed cookies it is
 * the only legal value. A browser rejects a `__Host-` cookie outright unless it is `Secure`,
 * has **`Path=/`** and carries no `Domain` attribute (RFC 6265bis §4.1.3). "Reject" means the
 * cookie is never stored at all — not sent-but-ignored, and with no error anywhere the server
 * can see.
 *
 * **Do not narrow this back to `/api/v1/auth` for the refresh cookie (T-058).** That is exactly
 * what shipped originally, and it meant the refresh cookie was silently discarded by every
 * browser, so no session could survive the 15-minute access-token lifetime. It passed review
 * because neither `curl` nor `supertest` implements cookie-prefix rules — they store and replay
 * whatever `Set-Cookie` says, so only a real browser can catch it.
 *
 * The narrow path was originally chosen so the refresh token would not ride along on ordinary
 * API calls. That benefit is real but secondary: `Path` is not a security boundary, and the
 * exposure it reduced is already covered by `httpOnly`, `SameSite=Strict` and the log redaction
 * in 02-SECURITY.md §7. The subdomain-injection foreclosure `__Host-` buys is browser-enforced
 * and has no equivalent elsewhere in the design, so it wins (02-SECURITY.md §1, corrected
 * 2026-08-20).
 */
export const ROOT_COOKIE_PATH = '/';

// --- Row statuses (01-DATABASE.md §2.3–2.4, enforced by CHECK constraints) -------------------

export const SESSION_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
});

export const REFRESH_TOKEN_STATUS = Object.freeze({
  ACTIVE: 'active',
  CONSUMED: 'consumed',
  REVOKED: 'revoked',
});

/**
 * `portal_sessions.revoked_reason` — `varchar(60)`, so every value here must stay short.
 * Operator-facing forensics only; none of these strings ever reaches a response body.
 */
export const REVOCATION_REASON = Object.freeze({
  LOGOUT: 'logout',
  LOGOUT_ALL: 'logout_all',
  USER_REVOKED: 'user_revoked',
  REFRESH_REUSE_DETECTED: 'refresh_reuse_detected',
  PASSWORD_CHANGED: 'password_changed',
  PASSWORD_RESET: 'password_reset',
});

// --- Audit events (01-DATABASE.md §2.5, `portal_audit_log.event_type` is varchar(60)) --------

/**
 * The authentication events this module appends to `portal_audit_log`.
 *
 * `REFRESH_REUSE_DETECTED` is the one 02-SECURITY.md §3 names by hand and T-011 TC-13 asserts
 * on; the rest exist because an alarm nobody can put in context is not much of an alarm. T-014
 * owns the general-purpose `AuditService` and the `@Audit()` interceptor for *domain* events —
 * this module writes its own rows directly because it must be able to audit a request that
 * never reaches a controller (a replayed refresh token is rejected before any handler runs),
 * and because a failed login has no authenticated actor for that interceptor to attribute it
 * to. Noted for the reviewer in the completion report.
 */
export const AUTH_AUDIT_EVENT = Object.freeze({
  LOGIN_SUCCEEDED: 'login_succeeded',
  LOGOUT: 'logout',
  LOGOUT_ALL: 'logout_all',
  SESSION_REVOKED: 'session_revoked',
  REFRESH_ROTATED: 'refresh_rotated',
  REFRESH_UNKNOWN: 'refresh_unknown',
  REFRESH_REJECTED: 'refresh_rejected',
  REFRESH_REUSE_DETECTED: 'refresh_reuse_detected',
  PASSWORD_CHANGED: 'password_changed',
  PASSWORD_RESET_REQUESTED: 'password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'password_reset_completed',
});

// --- Response codes (03-API-CONTRACT.md §1; `system_messages` keys seeded by T-004) ----------

/**
 * The API returns a **code**, never a sentence — the SPA looks the wording up in
 * `system_messages` (T004_004's own doc comment). Every code below is either already seeded
 * there or is added by this task's own follow-up seed; see the completion report.
 */
export const AUTH_ERROR_CODE = Object.freeze({
  /** Every login failure, without exception. See `auth.errors.ts` for why it has no siblings. */
  INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  /** No session, expired token, bad signature, revoked session, deactivated user. */
  SESSION_INVALID: 'AUTH_SESSION_INVALID',
  /** `must_change_password` is set and the route is not one of the two exempt ones. */
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  /** A new password that fails the policy. Carries `details`, unlike every other code here. */
  PASSWORD_POLICY: 'AUTH_PASSWORD_POLICY',
  /** A reset token that is unknown, already consumed, or expired — deliberately one code. */
  RESET_TOKEN_INVALID: 'AUTH_RESET_TOKEN_INVALID',
  /** Not found, or out of scope — deliberately indistinguishable (02-SECURITY.md §5.1). */
  NOT_FOUND: 'NOT_FOUND',
});
