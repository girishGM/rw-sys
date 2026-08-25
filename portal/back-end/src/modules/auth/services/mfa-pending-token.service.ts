/**
 * T-055 — the `MFA_PENDING` token: mint, and verify.
 *
 * ---
 *
 * ### What this token is, stated as precisely as implementation note 4 states it
 *
 * > *"The `MFA_PENDING` token is not a session. It carries no `sid`, cannot be exchanged for any
 * > route other than `/auth/mfa/enrol`, `/auth/mfa/verify`, `/auth/mfa/recover` and
 * > `/auth/logout`, and expires in 5 minutes. It must not appear in `portal_sessions` — an
 * > abandoned MFA challenge must not count as, or be revocable as, a real session."*
 *
 * Each of those clauses is a property of the code below rather than of a convention:
 *
 *  - **No `sid`, structurally.** {@link MfaPendingClaims} has no session field to populate. The
 *    token names a *user* and a *state* (`enrolled`), nothing else.
 *  - **No `portal_sessions` row, structurally.** This service touches no database at all. There
 *    is no code path from minting a pending token to inserting a session row, so TC-14 is a
 *    property of the design and not of remembering to skip a call.
 *  - **Five minutes, in the token.** `exp` is signed, so the lifetime cannot be extended by the
 *    holder, and it is asserted on every verification.
 *  - **Confined to four routes.** That part is enforced by `MfaPendingConfinementGuard` and by
 *    the fact that no other guard in the chain will ever look at this cookie: `JwtAuthGuard`
 *    reads `__Host-rs_at` and verifies it as an RS256 JWT, which this token is not and cannot be
 *    mistaken for (different cookie, different format, different key, different algorithm).
 *
 * ### Why HMAC over a random opaque token in a table
 *
 * A stored token would be the obvious design and is the wrong one here: the only tables available
 * are `portal_sessions` — which note 4 forbids this from touching — and a new one, which the task
 * does not authorise (its single migration creates `portal_mfa_recovery_codes` and nothing else).
 * An HMAC-signed token needs no storage: it is unforgeable without the key, it carries its own
 * expiry, and an abandoned challenge leaves no row anywhere to clean up or to mistake for a
 * session.
 *
 * The cost of statelessness is that this token cannot be *revoked* individually, and that a
 * holder can present it more than once inside its five minutes. Both are bounded and neither is
 * load-bearing: presenting it again still requires a live TOTP code or an unused recovery code,
 * and `throttler.config.ts` charges a 5-per-15-minute counter keyed by this token's own digest,
 * so a stolen pending token buys at most five attempts. Recorded in the completion report.
 *
 * ### Where the key comes from
 *
 * HKDF-SHA256 over the RS256 signing key's DER encoding, with its own `info` string — exactly the
 * construction `TokenService.csrfTokenFor` uses for the CSRF HMAC, and for the same reasons: the
 * derived key is cryptographically independent of the signing key despite sharing its entropy, it
 * needs no additional secret to be configured (R4: no new secret to leak), and it rotates
 * automatically whenever the signing key does — which correctly invalidates every in-flight
 * challenge at the moment the key changes.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, createPrivateKey, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Env } from '@/config/env.schema';
import {
  MFA_PENDING_TOKEN_MAX_LENGTH,
  MFA_PENDING_TOKEN_VERSION,
  MFA_PENDING_TTL_SECONDS,
} from '../mfa.constants';
import { SigningKeyError } from './token.service';

/** What a verified pending token asserts. Deliberately three fields and no more. */
export interface MfaPendingClaims {
  /** `portal_users.id` — the account whose password has already been verified. */
  readonly userId: number;
  /**
   * `portal_users.mfa_enabled` as it stood when the challenge was issued.
   *
   * Carried so the confinement guard can answer `MFA_ENROLMENT_REQUIRED` rather than
   * `MFA_PENDING` without a database read on a route it is about to reject anyway. **It is never
   * trusted for an authorisation decision**: `MfaService` re-reads the live row before enrolling
   * or verifying anybody, so a token minted a moment before an administrator's reset cannot be
   * used to skip the reset.
   */
  readonly enrolled: boolean;
  readonly expiresAt: Date;
}

/** The signed payload, as it appears on the wire. Short keys — this travels in a cookie. */
interface PendingPayload {
  u: number;
  e: boolean;
  iat: number;
  exp: number;
  /** A nonce, so two challenges issued in the same second are distinct tokens. */
  n: string;
}

/** The base64url alphabet, one or more characters. No padding, no `+`/`/`. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

@Injectable()
export class MfaPendingTokenService {
  private readonly key: Buffer;

  constructor(configService: ConfigService<Env, true>) {
    this.key = derivePendingKey(configService.get('JWT_PRIVATE_KEY', { infer: true }));
  }

  /**
   * Mints a token for a user whose password has just been verified.
   *
   * Called from exactly one place — `TotpStepUpHook`, i.e. after `CredentialService.authenticate`
   * has succeeded and before any session exists. Minting one anywhere else would be minting a
   * credential for an account nobody has authenticated to.
   */
  mint(input: { userId: number; enrolled: boolean }, now: Date = new Date()): string {
    const issuedAtSeconds = Math.floor(now.getTime() / 1000);

    const payload: PendingPayload = {
      u: input.userId,
      e: input.enrolled,
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + MFA_PENDING_TTL_SECONDS,
      n: randomBytes(9).toString('base64url'),
    };

    const body = `${MFA_PENDING_TOKEN_VERSION}.${encodeSegment(payload)}`;
    return `${body}.${this.sign(body)}`;
  }

  /**
   * Verifies a presented token, returning its claims or `null`.
   *
   * **Never throws**, for every input including garbage: this runs in a guard that sits in front
   * of every route in the application, so a malformed cookie must be "you are anonymous", not a
   * 500. And it returns one undifferentiated `null` for expired, forged, truncated and
   * wrong-version alike — the holder of a bad token learns only that it is bad, which is the same
   * discipline `SessionInvalidHttpException` applies one layer up.
   *
   * The order is the same as `TokenService.verifyAccessToken`'s and for the same reason: cheap
   * structural checks, then the signature, and **nothing derived from the payload is used before
   * the MAC has been verified**.
   */
  verify(token: string, now: Date = new Date()): MfaPendingClaims | null {
    if (token.length === 0 || token.length > MFA_PENDING_TOKEN_MAX_LENGTH) return null;

    const segments = token.split('.');
    if (segments.length !== 3) return null;

    const [version, payloadSegment, signatureSegment] = segments;
    if (version !== MFA_PENDING_TOKEN_VERSION) return null;
    if (!BASE64URL.test(payloadSegment) || !BASE64URL.test(signatureSegment)) return null;

    const expected = this.sign(`${version}.${payloadSegment}`);
    if (!constantTimeEquals(signatureSegment, expected)) return null;

    // --- everything below this line is operating on authenticated data ------------------------
    const payload = decodeSegment(payloadSegment);
    if (payload === null) return null;

    const nowSeconds = Math.floor(now.getTime() / 1000);
    // `<=`: a token is dead *at* its expiry second, matching `TokenService`'s treatment of `exp`.
    if (payload.exp <= nowSeconds) return null;

    return {
      userId: payload.u,
      enrolled: payload.e,
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body, 'utf8').digest('base64url');
  }
}

// --- helpers ---------------------------------------------------------------------------------

function encodeSegment(payload: PendingPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes and validates the payload of an **already MAC-verified** token.
 *
 * Every field is asserted even though the MAC proves this process minted it: a token minted by an
 * older build, or by a build with a bug, is still a token this build must not act on. The cost is
 * five comparisons; the alternative is trusting a shape rather than checking it.
 */
function decodeSegment(segment: string): Omit<PendingPayload, 'n'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const candidate = parsed as Partial<PendingPayload>;

  if (typeof candidate.u !== 'number' || !Number.isInteger(candidate.u) || candidate.u <= 0) {
    return null;
  }
  if (typeof candidate.e !== 'boolean') return null;
  if (!isFiniteNumber(candidate.iat)) return null;
  if (!isFiniteNumber(candidate.exp)) return null;

  // The nonce is deliberately not returned: it exists to make two tokens minted in the same
  // second distinct, and nothing above this line has any use for it.
  return { u: candidate.u, e: candidate.e, iat: candidate.iat, exp: candidate.exp };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function constantTimeEquals(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * HKDF-SHA256 over the signing key's DER encoding.
 *
 * The PEM normalisation mirrors `token.service.ts`'s (`.env` files cannot hold literal newlines,
 * so the value arrives with `\n` escapes and sometimes surrounding quotes). It is repeated here
 * rather than imported because that helper is private to a file this task does not own; the
 * duplication is eight lines and is flagged in the completion report.
 *
 * The exported DER is zero-filled immediately: it is the private key in raw form, and there is no
 * reason for a second copy to sit in the heap for the lifetime of the process.
 */
function derivePendingKey(privatePem: string): Buffer {
  const unquoted = privatePem.trim().replace(/^["']|["']$/g, '');
  let der: Buffer;
  try {
    der = createPrivateKey(unquoted.replace(/\\n/g, '\n')).export({
      type: 'pkcs8',
      format: 'der',
    });
  } catch (error) {
    // Unreachable in the running application — `TokenService` is constructed from the same value
    // and fails the boot first — but this service must not depend on another provider's
    // construction order for its own correctness. The message never quotes the input.
    throw new SigningKeyError(
      `JWT_PRIVATE_KEY is not a valid PEM key (${(error as Error).name}) — refusing to start.`,
    );
  }

  try {
    return Buffer.from(
      hkdfSync('sha256', der, Buffer.from('reward-portal/mfa', 'utf8'), 'mfa-pending-token', 32),
    );
  } finally {
    der.fill(0);
  }
}
