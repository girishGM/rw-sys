/**
 * T-035 — the body of `POST /users`.
 *
 * `role` is required and validated against the six-role union, but **which** of the three scope
 * ids below is actually read is decided entirely server-side, by the actor's own role
 * (`UsersService.create()`'s own header carries the full table). All three are declared here,
 * all optional, purely so `ValidationPipe`'s `forbidNonWhitelisted: true` (`main.ts`) does not
 * reject a legitimate caller's body outright — a `country_admin` creating a `tenant_admin` must
 * be able to send `tenantId`, a `super_admin` creating a `country_admin` must be able to send
 * `countryId`, and a `tenant_admin` creating a `merchant` must be able to send `merchantId`. Any
 * one of the three that does **not** match what the actor's own role needs is silently ignored
 * by the service (T-035 TC-11) — never trusted, per AGENT-PROTOCOL R3.
 *
 * No `password` field anywhere — the server generates it (BACKLOG.md B-01); an admin-chosen
 * password is guessable and reused across users.
 */
import { IsEmail, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { PortalRole } from '@/database/portal-models';
import { USER_DISPLAY_NAME_MAX_LENGTH, USER_EMAIL_MAX_LENGTH } from '../users.constants';

/** `ck_portal_users_role`. */
export const PORTAL_ROLE_VALUES: readonly PortalRole[] = [
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
];

export class CreateUserDto {
  @IsEmail()
  @MaxLength(USER_EMAIL_MAX_LENGTH)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(USER_DISPLAY_NAME_MAX_LENGTH)
  displayName!: string;

  @IsIn(PORTAL_ROLE_VALUES)
  role!: PortalRole;

  /** Read only when the actor is `super_admin` creating a `country_admin`. */
  @IsOptional()
  @IsInt()
  countryId?: number;

  /** Read only when the actor is `country_admin` creating a `tenant_admin`. */
  @IsOptional()
  @IsInt()
  tenantId?: number;

  /** Read only when the actor is `tenant_admin` creating a `merchant`. */
  @IsOptional()
  @IsInt()
  merchantId?: number;
}
