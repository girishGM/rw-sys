/**
 * T-055 — request bodies for `/auth/mfa/*`.
 *
 * ### R3, stated for this file specifically
 *
 * **No DTO here carries a user id, a role, a tenant, a country or a merchant.** The account a
 * challenge belongs to comes from the signed pending token and from nowhere else; the account an
 * administrative reset acts *on* comes from the URL and is checked against the database. A field
 * named `userId` in any of these classes would be a bug in the sense AGENT-PROTOCOL R3 means it.
 *
 * ### Why `mfaPendingToken` is optional
 *
 * 02-SECURITY.md §2a writes the verify call as `{ mfaPendingToken, totpCode }`, so the field
 * exists and is accepted. In the browser it is normally absent, because the token travels in the
 * `__Host-rs_mfa` cookie the login response set — see `mfa.constants.ts` for why the server puts
 * it there rather than in the login body. The controller reads the body first and falls back to
 * the cookie, so both a scripted client following §2a literally and the SPA following the cookie
 * work, with one code path behind them.
 *
 * `@MaxLength` on every field, as `auth-request.dto.ts` does: these routes are reachable without
 * a session, and an unbounded string is an unbounded amount of work for an anonymous caller.
 */
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  MFA_PENDING_TOKEN_MAX_LENGTH,
  RECOVERY_CODE_GROUPS,
  RECOVERY_CODE_GROUP_LENGTH,
  TOTP_DIGITS,
} from '../mfa.constants';

/** Twelve characters of code, before the two separators a printed code carries. */
const RECOVERY_CODE_MIN_LENGTH = RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_LENGTH;

/** Shared by all three routes. See the file header for why it is optional. */
class MfaPendingTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(MFA_PENDING_TOKEN_MAX_LENGTH)
  readonly mfaPendingToken?: string;
}

/** `POST /auth/mfa/enrol` — the pending token is the entire request. */
export class MfaEnrolDto extends MfaPendingTokenDto {}

/**
 * `POST /auth/mfa/verify`.
 *
 * The code is validated only for *length*, not for shape: `verifyTotpCode` rejects anything that
 * is not six digits anyway, and doing it here as well would mean a malformed code produced a
 * `400` with field details while a wrong one produced a generic `401` — a difference an attacker
 * could use to probe. One answer for every bad code (02-SECURITY.md §2a).
 */
export class MfaVerifyDto extends MfaPendingTokenDto {
  @IsString()
  @MinLength(TOTP_DIGITS)
  @MaxLength(TOTP_DIGITS + 2)
  readonly totpCode!: string;
}

/**
 * `POST /auth/mfa/recover`.
 *
 * `xxxx-xxxx-xxxx` is 14 characters; the bounds allow for the separators being omitted (12) and
 * for a little whitespace, both of which `hashRecoveryCode` normalises away.
 */
export class MfaRecoverDto extends MfaPendingTokenDto {
  @IsString()
  @MinLength(RECOVERY_CODE_MIN_LENGTH)
  @MaxLength(32)
  readonly recoveryCode!: string;
}
