/**
 * T-055 — the response bodies `/auth/mfa/*` returns, and the only shapes they may return.
 *
 * ### TC-18, and how this file guarantees it
 *
 * *"Response bodies across all MFA endpoints scanned → no secret, no recovery code, no hash
 * beyond what TC-1/TC-11 explicitly return once."*
 *
 * As in `auth-response.dto.ts`, the guarantee comes from construction rather than filtering:
 * every field of every type below is declared here by hand and built as a fresh literal, so no
 * database row, model instance or repository result is ever returned. `mfa_secret_enc` cannot
 * escape through this file because nothing here has a field for it — the *ciphertext* is never
 * returned at all, and the plaintext appears exactly once, in {@link MfaEnrolmentResponseDto},
 * on the one call that mints it.
 *
 * ### The two deliberate exceptions, and why neither is a hole
 *
 * `secret` (enrolment) and `recoveryCodes` (the call that completes an enrolment) are *required*
 * by TC-1 and by implementation notes 2 and 3: a seed nobody can see cannot be scanned, and
 * recovery codes nobody can read cannot be written down. Both are shown **once**, on a response
 * to a request that already proved possession of the account's password:
 *
 *  - the seed is unobtainable afterwards — `POST /auth/mfa/enrol` answers 403 once
 *    `mfa_enabled` is true (TC-2), and no other endpoint reads that column;
 *  - the codes are unobtainable afterwards — only their SHA-256 digests are stored, so the
 *    portal itself cannot reproduce them.
 *
 * Everything else on these responses is a boolean, a count or a role.
 */
import type { PortalRole } from '@/database/portal-models';
import type { EnrolmentOffer, MfaLoginResult } from '../services/mfa.service';

/**
 * `POST /auth/mfa/enrol` — shown once, at enrolment, and never again (implementation note 2).
 *
 * `otpauthUri` carries the same seed as `secret`, in the form an authenticator app consumes. The
 * QR code itself is rendered **client-side** from this URI: no QR encoder is available to this
 * workspace, and returning a server-rendered image would put the seed into an additional
 * representation (a PNG in a cache, a proxy log, a browser's image cache) for no benefit.
 * Recorded as a deviation in the completion report.
 */
export class MfaEnrolmentResponseDto {
  readonly secret!: string;
  readonly otpauthUri!: string;
  readonly issuer!: string;
  readonly account!: string;
  readonly algorithm!: string;
  readonly digits!: number;
  readonly periodSeconds!: number;
}

export function toEnrolmentResponse(offer: EnrolmentOffer): MfaEnrolmentResponseDto {
  return {
    secret: offer.secret,
    otpauthUri: offer.otpauthUri,
    issuer: offer.issuer,
    account: offer.account,
    algorithm: offer.algorithm,
    digits: offer.digits,
    periodSeconds: offer.periodSeconds,
  };
}

/**
 * `POST /auth/mfa/verify` and `POST /auth/mfa/recover` on success.
 *
 * Deliberately the same three fields `LoginResponseDto` carries — `role`, `mustChangePassword`,
 * `mfaRequired` — plus the two one-shot extras. A satisfied challenge produces exactly what an
 * ordinary login produces (TC-6), so the SPA's post-login handling is one code path, and
 * `mfaRequired` is present and `false` rather than absent so that "the challenge is done" is
 * stated rather than inferred.
 *
 * The three session cookies are set by the controller. **No token appears in this body**, for the
 * reason `auth-response.dto.ts` gives: a body that echoed the access token would defeat the whole
 * httpOnly design in one line.
 */
export class MfaVerifiedResponseDto {
  readonly role!: PortalRole;
  readonly mustChangePassword!: boolean;
  readonly mfaRequired!: boolean;
  /** Present exactly once, on the call that completes an enrolment (TC-1). */
  readonly recoveryCodes?: readonly string[];
  /** Present on the recovery path, so the user knows how many codes they have left (TC-11). */
  readonly recoveryCodesRemaining?: number;
}

export function toVerifiedResponse(result: MfaLoginResult): MfaVerifiedResponseDto {
  return {
    role: result.role,
    mustChangePassword: result.mustChangePassword,
    mfaRequired: false,
    ...(result.recoveryCodes === undefined ? {} : { recoveryCodes: result.recoveryCodes }),
    ...(result.recoveryCodesRemaining === undefined
      ? {}
      : { recoveryCodesRemaining: result.recoveryCodesRemaining }),
  };
}
