/**
 * T-034 — the body of `POST /tenants/:id/admins`, and the nested `admin` field of
 * `POST /tenants` (implementation note 5: "Tenant + Tenant Admin creation in one transaction, as
 * with T-030").
 *
 * Deliberately two fields and no more, the same discipline `create-country-admin.dto.ts`
 * documents: no `password` (BACKLOG.md B-01 — the server generates it), no `role` (always
 * `tenant_admin`, never client-supplied — AGENT-PROTOCOL R3), no `tenantId`/`countryId` (taken
 * from the route param / the just-created row and the actor's own scope, never from the body).
 */
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import {
  TENANT_ADMIN_DISPLAY_NAME_MAX_LENGTH,
  TENANT_ADMIN_EMAIL_MAX_LENGTH,
} from '../tenants.constants';

export class CreateTenantAdminDto {
  @IsEmail()
  @MaxLength(TENANT_ADMIN_EMAIL_MAX_LENGTH)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(TENANT_ADMIN_DISPLAY_NAME_MAX_LENGTH)
  displayName!: string;
}
