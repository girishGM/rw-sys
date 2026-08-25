/**
 * T-035 — the body of `PATCH /users/:id`.
 *
 * `displayName` is the only field a caller may ever change through this route. `role` is
 * declared here too, purely so a hand-crafted request that includes it is a *validation pass,
 * service-layer 403* (TC-28) rather than a `forbidNonWhitelisted` 400 that would look like a
 * shape error instead of the authorisation refusal it actually is — `UsersService.update()`
 * rejects it outright, for every value, not only an escalating one; see that method's own
 * header. Neither `email` nor any scope id (`countryId`/`tenantId`/`merchantId`) is settable
 * here at all: an email change is identity-changing enough to deserve its own flow (out of this
 * task's scope), and a scope id is never client-writable per AGENT-PROTOCOL R3.
 */
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { PortalRole } from '@/database/portal-models';
import { USER_DISPLAY_NAME_MAX_LENGTH } from '../users.constants';
import { PORTAL_ROLE_VALUES } from './create-user.dto';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(USER_DISPLAY_NAME_MAX_LENGTH)
  displayName?: string;

  /** Always rejected when present — see the file header. */
  @IsOptional()
  @IsIn(PORTAL_ROLE_VALUES)
  role?: PortalRole;
}
