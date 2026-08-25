/**
 * T-011 — the request bodies `/auth/*` accepts.
 *
 * ### What is deliberately absent
 *
 * Not one of these carries `role`, `tenantId`, `countryId`, `merchantId`, `userId` or `sessionId`
 * (R3). The global `ValidationPipe` runs with `forbidNonWhitelisted: true`, so a body that adds
 * one is **rejected with 400**, not silently stripped — which is what turns a mass-assignment
 * probe such as `{"email":"…","password":"…","role":"super_admin"}` into a visible failure
 * instead of a request that quietly did something slightly different from what it asked for
 * (02-SECURITY.md §6).
 *
 * The session id is likewise never an input: `POST /auth/logout` acts on the session in the
 * verified token, and `DELETE /auth/sessions/:id` is filtered by `user_id` in the WHERE clause.
 *
 * ### Length bounds are a control, not tidiness
 *
 * Every string here is bounded. `/auth/login`, `/auth/forgot-password` and
 * `/auth/reset-password` are reachable **before** authentication and every one of them leads to
 * an Argon2id verification or a database write, so an unbounded field is a way for a stranger to
 * ask the server to do unbounded work. The bounds match the columns and constants they feed:
 * `portal_users.email` is `varchar(200)`, and `PASSWORD_MAX_LENGTH` is T-010's own ceiling.
 */
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth.constants';

/** `portal_users.email` is `varchar(200)`. */
const EMAIL_MAX_LENGTH = 200;

/** Opaque reset tokens are 32 random bytes as base64url (43 chars); the bound is generous. */
const RESET_TOKEN_MAX_LENGTH = 512;

export class LoginDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  /**
   * Bounded but **not** policy-checked. A login is a comparison against a stored hash, and the
   * policy may have tightened since this password was set — rejecting a valid current password
   * here because it is only 10 characters would lock out exactly the users who most need to
   * reach `/auth/change-password`. `MinLength(1)` only rejects the empty string.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class ChangePasswordDto {
  /**
   * Required. `CredentialService.changePassword` treats an absent current password as "an
   * administrative or reset-token-driven change", which is a legitimate mode with its own
   * authority — and one this endpoint does not have. Making the field mandatory here is what
   * stops a stolen session from silently changing the password it does not know
   * (03-API-CONTRACT.md §2: "Requires current password").
   */
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(RESET_TOKEN_MAX_LENGTH)
  token!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}
