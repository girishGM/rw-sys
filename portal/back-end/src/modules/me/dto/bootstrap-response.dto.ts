/**
 * T-015 — the response bodies `/me/*` returns, and the only shapes it may return.
 *
 * ### Built by hand, never spread from a row
 *
 * The same construction rule `auth-response.dto.ts` records for T-011, and for the same reason:
 * every field below is declared explicitly and every mapping function builds a **fresh literal**.
 * No Sequelize model instance, no repository row and no `...spread` of one ever reaches a
 * response. That is what makes T-015 TC-15 (*"no hash, no token, no other user's data"*) a
 * property of the code rather than of somebody remembering to exclude a column — `portal_users`
 * carries `mfa_secret_enc`, and `PortalUser`'s default scope excluding it is the second line of
 * defence here, not the first.
 *
 * ### The shape is fixed by 00-ARCHITECTURE.md §7
 *
 * ```jsonc
 * { "user": {...}, "scope": {...}, "nav": [...], "permissions": {...},
 *   "widgets": [...], "messages": {...} }
 * ```
 *
 * and is mirrored field-for-field by `packages/shared/src/bootstrap.schema.ts`, which the SPA
 * validates against. The two are kept honest by `test/me/bootstrap.contract.spec.ts`, which parses
 * a real response through the shared schema — whose objects are `.strict()`, so an added field
 * fails there rather than shipping unnoticed.
 */
import type { PortalRole } from '@/database/portal-models';

/**
 * The success envelope from 03-API-CONTRACT.md §1: `{ "data": … }`.
 *
 * Declared here rather than imported from `modules/auth/dto/auth-response.dto.ts`, which has an
 * identical pair. The envelope is an API-wide convention that no task in the plan owns a home
 * for; importing T-011's copy would make `/me` depend on the auth module's DTO file for a
 * two-field structural type and gain nothing that a shared definition would. Flagged in the
 * completion report along with T-011's own note: if a global wrapping interceptor is ever added,
 * it must skip these routes or it will double-wrap them.
 */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

/** The scope triple (00-ARCHITECTURE.md §5.1), reported exactly as the server enforces it. */
export interface BootstrapScopeDto {
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
}

/**
 * The authenticated user — the five fields §7 lists, and no others.
 *
 * `role` and the scope triple come from the **verified JWT**, not from the `portal_users` row
 * this endpoint also reads (AGENT-PROTOCOL R3). That is not merely rule-following: the JWT's role
 * is what `RolesGuard`, `PermissionsGuard` and `ScopedRepository` actually enforce for the life of
 * this access token, so reporting the row's role would tell the SPA to render a menu the API would
 * then refuse. The row is authoritative again on the next refresh, which re-derives the claims
 * from it (T-011, AR-04).
 */
export interface BootstrapUserDto {
  readonly id: number;
  readonly displayName: string;
  readonly role: PortalRole;
  readonly locale: string;
  readonly timezone: string | null;
}

/** One node of the nav tree. `children` is always present, empty for a leaf. */
export interface BootstrapNavItemDto {
  readonly key: string;
  readonly label: string;
  readonly icon: string | null;
  readonly path: string;
  readonly children: readonly BootstrapNavItemDto[];
}

/** One dashboard widget. `config` is always an object — see `toWidgetConfig` in the service. */
export interface BootstrapWidgetDto {
  readonly key: string;
  readonly label: string;
  readonly config: Record<string, unknown>;
}

/**
 * `{ entity: actions[] }` (implementation note 3) — flat, because that is what the SPA needs and
 * it keeps a payload sent on every login small.
 */
export type BootstrapPermissionsDto = Record<string, readonly string[]>;

/** The `system_messages` catalogue, keyed by code (01-DATABASE.md §5.4). */
export type BootstrapMessagesDto = Record<string, string>;

/** `GET /me/bootstrap`. */
export interface BootstrapDto {
  readonly user: BootstrapUserDto;
  readonly scope: BootstrapScopeDto;
  readonly nav: readonly BootstrapNavItemDto[];
  readonly permissions: BootstrapPermissionsDto;
  readonly widgets: readonly BootstrapWidgetDto[];
  readonly messages: BootstrapMessagesDto;
}

/**
 * `GET /me` — the caller's own profile.
 *
 * Wider than {@link BootstrapUserDto} because a profile screen legitimately shows the address the
 * account is keyed on and whether a password change is outstanding. Still nothing credential-
 * bearing: no hash, no MFA secret, no session or token material, and no field belonging to any
 * user but the caller.
 */
export interface MeProfileDto {
  readonly id: number;
  readonly email: string;
  readonly displayName: string;
  readonly role: PortalRole;
  readonly scope: BootstrapScopeDto;
  readonly locale: string;
  readonly timezone: string | null;
  readonly status: string;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: string | null;
}
