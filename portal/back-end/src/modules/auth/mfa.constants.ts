/**
 * T-055 — every tunable number, literal and enumerated value the mandatory-MFA layer depends on,
 * in one place, exactly as `auth.constants.ts` (T-010) and `session.constants.ts` (T-011) do for
 * the credential and session layers. A reviewer should be able to check this whole policy against
 * [02-SECURITY.md](../../../project-plan/02-SECURITY.md) §2a and
 * [01-DATABASE.md](../../../project-plan/01-DATABASE.md) §2.5a without reading a service.
 *
 * **Nothing here is a secret** (R4). The TOTP parameters are published in every `otpauth://` URI
 * the portal hands out, the cookie name appears in every response header, and the audit event
 * names appear in the audit log. The only secrets in this feature are the per-user TOTP seed
 * (encrypted at rest through T-016 and never returned after enrolment) and the recovery codes
 * (shown once, stored as SHA-256 digests).
 */
import type { CookieDefinition } from './auth.cookies';
import { ROOT_COOKIE_PATH } from './session.constants';

// --- TOTP (RFC 6238), implementation note 1 --------------------------------------------------

/**
 * The hash under HMAC. **SHA-1, deliberately.**
 *
 * RFC 6238 permits SHA-256 and SHA-512, and in isolation either is the stronger primitive. They
 * are the wrong choice here anyway: SHA-1 is the default assumed by essentially every
 * authenticator app in existence, several of which silently *ignore* the `algorithm` parameter
 * in an `otpauth://` URI and compute SHA-1 regardless — producing codes this server would then
 * reject, with no diagnostic the user could act on. T-055 implementation note 1 forbids exactly
 * that trade ("do not pick a non-default algorithm that breaks common apps").
 *
 * The security argument for why this is not a weakening: HMAC-SHA1's security does not rest on
 * collision resistance, which is the SHA-1 property that is broken. The attacker's problem here
 * is guessing a 6-digit number inside a 30-second window, bounded by the rate limits in
 * `throttler.config.ts` — not finding a SHA-1 collision.
 */
export const TOTP_ALGORITHM = 'sha1';

/** Digits in a code. Six, the universal authenticator-app default (RFC 6238 §5.1). */
export const TOTP_DIGITS = 6;

/** Time step, in seconds. Thirty, likewise the universal default. */
export const TOTP_PERIOD_SECONDS = 30;

/**
 * Accepted clock skew, in **steps** either side of the current one.
 *
 * One step, no more (implementation note 1). Each extra step multiplies the window in which any
 * single code is accepted — at ±1 a code is live for at most 90 seconds, at ±3 for 210 — and
 * every one of those seconds is time a shoulder-surfed or phished code stays usable.
 */
export const TOTP_SKEW_STEPS = 1;

/**
 * TOTP seed length in bytes.
 *
 * Twenty (160 bits): RFC 4226 §4 requires at least 128 bits and recommends 160, which is also
 * the HMAC-SHA1 output length, so nothing is gained by going longer and shorter is below the
 * standard's floor.
 */
export const TOTP_SECRET_BYTES = 20;

/** `otpauth://totp/<issuer>:<account>` — the label a user sees in their authenticator app. */
export const TOTP_ISSUER = 'Reward Portal';

// --- The MFA_PENDING token (implementation note 4) --------------------------------------------

/**
 * How long a half-finished login stays resumable. Five minutes, per implementation note 4.
 *
 * Long enough to open an authenticator app and type six digits; short enough that a token
 * captured from a log, a proxy or a shoulder is dead before it can be carried anywhere.
 */
export const MFA_PENDING_TTL_SECONDS = 5 * 60;

/**
 * The version tag every pending token carries. Present so a future format change is a *rejection*
 * of the old shape rather than a misparse of it — the same reason `ciphertext.ts` versions the
 * crypto envelope.
 */
export const MFA_PENDING_TOKEN_VERSION = 'mfa1';

/**
 * Hard ceiling on the length of a pending token this process will attempt to verify, mirroring
 * `JWT_MAX_LENGTH`'s reasoning: bound the work an unauthenticated caller can request on a route
 * that runs before any session exists. A real token is ~130 characters.
 */
export const MFA_PENDING_TOKEN_MAX_LENGTH = 1024;

/**
 * The cookie a half-authenticated caller carries.
 *
 * ### Why the pending token is a cookie and not a response-body field
 *
 * 02-SECURITY.md §2a sketches the verify call as `{ mfaPendingToken, totpCode }`, i.e. the token
 * in the request body — and `mfa-request.dto.ts` accepts it there, so that shape works. What the
 * *server* does with it on the way out is a separate question, and the body is the wrong answer
 * for three reasons:
 *
 *  1. `auth-response.dto.ts` states, and T-011 TC-26 enforces with a recursive scan of every
 *     `/auth/*` response body, that **no auth response carries a token of any kind**. A field
 *     named `mfaPendingToken` fails that scan by name, and rightly: it would be a credential
 *     placed somewhere script on the page can read it — R5's principle, if not the letter of its
 *     browser-storage wording. (The wording is deliberately not quoted here: T-011's verification
 *     step 6 greps `src/` for those two API names and treats *any* occurrence, comment or code,
 *     as a finding. That is the right amount of crude for a rule this important.)
 *  2. `LoginResponseDto.mfaRequired`'s own comment says the SPA contract must *not* change when
 *     T-055 lands. A cookie keeps that promise exactly.
 *  3. The SPA never has to hold the value at all, so there is no place for it to leak from.
 *
 * `Path=/` rather than `/api/v1/auth`, which is what makes `MfaPendingConfinementGuard` able to
 * answer 403 on *any* route the confined caller tries — see that guard for why a clear 403 beats
 * the 401 an absent cookie would produce.
 *
 * `HttpOnly` because nothing in the browser needs to read it, `Secure` and `SameSite=Strict`
 * because every cookie this module emits is, and `__Host-` because the prefix forecloses
 * subdomain cookie injection (see `session.constants.ts` for the full argument).
 */
export const MFA_PENDING_COOKIE_NAME = '__Host-rs_mfa';

export const MFA_PENDING_COOKIE: CookieDefinition = Object.freeze({
  name: MFA_PENDING_COOKIE_NAME,
  path: ROOT_COOKIE_PATH,
  httpOnly: true,
  maxAgeSeconds: MFA_PENDING_TTL_SECONDS,
});

// --- Recovery codes (01-DATABASE.md §2.5a, implementation note 3) -----------------------------

/** Ten codes per enrolment, per implementation note 3 and 01-DATABASE.md §2.5a. */
export const RECOVERY_CODE_COUNT = 10;

/** `xxxx-xxxx-xxxx` — three groups of four. */
export const RECOVERY_CODE_GROUPS = 3;
export const RECOVERY_CODE_GROUP_LENGTH = 4;

/**
 * The alphabet a recovery code is drawn from: Crockford-style base32, i.e. digits and uppercase
 * letters with `I`, `L`, `O` and `U` removed.
 *
 * These are codes a human copies off a screen onto paper and types back months later under
 * stress. `I`/`1`, `O`/`0` and `L`/`1` are the transcription errors that turn a valid recovery
 * code into a support ticket, and `U` is dropped so no random draw spells an unfortunate word.
 * 32 symbols × 12 characters = 60 bits per code — far beyond guessable, and the per-token rate
 * limit bounds attempts regardless.
 */
export const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// --- Audit events (`portal_audit_log.event_type` is varchar(60)) ------------------------------

/**
 * The MFA events this module appends to `portal_audit_log`, alongside T-011's `AUTH_AUDIT_EVENT`.
 *
 * `RECOVERY_USED` is the one 02-SECURITY.md §2a names by hand. `RECOVERY_REUSE` is the reason
 * 01-DATABASE.md §2.5a says a consumed row is never deleted: a second presentation of a code
 * that has already been spent is evidence that somebody other than the owner has the list, and
 * an alarm is worth more than the rejection on its own (TC-12).
 */
export const MFA_AUDIT_EVENT = Object.freeze({
  ENROLMENT_STARTED: 'mfa_enrolment_started',
  ENROLLED: 'mfa_enrolled',
  VERIFIED: 'mfa_verified',
  VERIFY_FAILED: 'mfa_verify_failed',
  RECOVERY_USED: 'mfa_recovery_used',
  RECOVERY_REUSE: 'mfa_recovery_reuse',
  RESET_BY_ADMIN: 'mfa_reset_by_admin',
  /**
   * Written by `SessionService.revokeAllForUser` on the two occasions this feature ends every
   * session an account has: a completed enrolment and an administrative reset. Distinct from both
   * of those events so the log distinguishes "the factor changed" from "and here is what that
   * cost in live sessions".
   */
  SESSIONS_REVOKED: 'mfa_sessions_revoked',
});

// --- Response codes (03-API-CONTRACT.md §1; `system_messages` keys) ---------------------------

/**
 * Codes this feature can return. Three of the four already exist in `system_messages`
 * (`MFA_PENDING` was seeded by T004_004, `AUTH_INVALID_CREDENTIALS` and `AUTH_SESSION_INVALID` by
 * T-011's catalogue); `MFA_ENROLMENT_REQUIRED` and `MFA_ALREADY_ENROLLED` are seeded by
 * `T055_001`. A missing key degrades to the key itself (`message.service.ts`), never to a
 * failure — but shipping the wording is still the job.
 */
export const MFA_ERROR_CODE = Object.freeze({
  /** 403 — a `super_admin` with `mfa_enabled = false` on any route outside the exempt list. */
  ENROLMENT_REQUIRED: 'MFA_ENROLMENT_REQUIRED',
  /** 403 — an enrolled `super_admin` whose challenge has not been satisfied yet. */
  PENDING: 'MFA_PENDING',
  /** 403 — `POST /auth/mfa/enrol` when the account is already enrolled (TC-2). */
  ALREADY_ENROLLED: 'MFA_ALREADY_ENROLLED',
});

/**
 * The revocation reason written to `portal_sessions.revoked_reason` (`varchar(60)`) when an
 * administrator resets somebody's MFA. Kept here rather than in T-011's `REVOCATION_REASON`
 * because that object is a done task's owned constant and this value belongs to this feature.
 */
export const MFA_RESET_REVOCATION_REASON = 'mfa_reset_by_admin';
