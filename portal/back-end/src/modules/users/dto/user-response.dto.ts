/**
 * T-035 — the response bodies `/users` returns, and the only shapes it may return.
 *
 * Built by hand from the model instance the service loads, never by spreading a Sequelize row —
 * the same construction rule `tenants/dto/tenant-response.dto.ts` records, for the same reason:
 * no credential field, ever, as a property of the code rather than of somebody remembering to
 * strip a column (T-035 TC-16/TC-29). `PortalUser`'s own `@DefaultScope` already excludes
 * `mfaSecretEnc`, and `passwordHash` lives on a different model entirely
 * (`PortalUserCredential`) that this DTO never touches — but {@link toUserDto} still names every
 * field explicitly rather than relying on either of those, so a future column added to the model
 * does not silently appear in a response.
 */
import type { PortalUser } from '@/database/portal-models';
import type { UserStatusValue } from '../users.constants';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent
 * `tenant-response.dto.ts` documents: this envelope is an API-wide convention no task owns a
 * shared home for. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

export interface ListMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface DataListEnvelope<T> {
  readonly data: readonly T[];
  readonly meta: ListMeta;
}

export interface UserDto {
  readonly id: number;
  readonly email: string;
  readonly displayName: string;
  readonly role: PortalUser['role'];
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
  readonly status: UserStatusValue;
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toUserDto(user: PortalUser): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    countryId: user.countryId,
    tenantId: user.tenantId,
    merchantId: user.merchantId,
    status: user.status as UserStatusValue,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/**
 * The one-time credential response's shape — `POST /users` and `POST /users/:id/reset-password`
 * (BACKLOG.md B-01) — moved to `./user-created-response.dto.ts` (T-046's own file, per its task
 * file's "Files owned"; that file imports {@link UserDto}/{@link toUserDto} from here, so it is
 * not re-exported back from this one — a two-way `export … from` between the pair would be a
 * circular module dependency for no reason). `users.service.ts` and `users.controller.ts` import
 * it from there directly.
 */
