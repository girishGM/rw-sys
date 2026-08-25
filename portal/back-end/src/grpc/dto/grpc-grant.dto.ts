/**
 * T-047 §4d — the bodies of `POST`/`PATCH /admin/grpc-grants`.
 *
 * ### `tenantId` in a DTO, and why this is not the R3 violation it looks like
 *
 * R3 says a `tenantId` in a DTO is a bug, and it is — **when it describes the actor**. Here it
 * describes the *subject* of an access-control row: which tenant the grant covers, chosen by a
 * `super_admin` who is global by definition and has no tenancy of their own to infer it from. The
 * actor's own scope is still never read from the body; `created_by` comes from the verified
 * session, not from here. Same shape and same reasoning as `CreateUserDto`'s three optional scope
 * ids (T-035), and as `POST /tenants` naming the country it creates a tenant in.
 *
 * `null`/absent means **every tenant** — see `T047_001`'s header on why that needs a generated
 * `tenant_key` column to stay unique.
 */
import { IsArray, IsIn, IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { ALL_SECTIONS, GRANT_STATUS, SERVICE_IDENTITY_MAX_LENGTH } from '../grpc.constants';

/** The grantable `ConfigSection` names, as strings, for `class-validator`. */
export const GRANTABLE_SECTIONS: readonly string[] = ALL_SECTIONS;

export const GRANT_STATUS_VALUES: readonly string[] = [GRANT_STATUS.ACTIVE, GRANT_STATUS.REVOKED];

export class CreateGrpcGrantDto {
  /** The client certificate SAN this grant is keyed on (§4c). `varchar(120)`. */
  @IsString()
  @MaxLength(SERVICE_IDENTITY_MAX_LENGTH)
  serviceIdentity!: string;

  /** Omit, or send `null`, for a grant covering every tenant. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  tenantId?: number | null;

  /** `BASIC` is added server-side whether or not it is listed — see the service's own comment. */
  @IsArray()
  @IsIn(GRANTABLE_SECTIONS, { each: true })
  allowedSections!: string[];
}

export class UpdateGrpcGrantDto {
  @IsOptional()
  @IsArray()
  @IsIn(GRANTABLE_SECTIONS, { each: true })
  allowedSections?: string[];

  /** Revocation is a status flip; the row is never deleted (`T047_001` revokes `DELETE`). */
  @IsOptional()
  @IsIn(GRANT_STATUS_VALUES)
  status?: string;
}
