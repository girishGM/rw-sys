/**
 * T-035 — the wire contract of `/users`: delegated user creation across the whole hierarchy
 * (03-API-CONTRACT.md §7), shared by the back end that produces it and the SPA that consumes it.
 * Same discipline every other `*.schema.ts` in this package states in full: bytes on the wire
 * only, no defaults the server never sent, no coercion, `.strict()` everywhere so an unexpected
 * key fails the contract test rather than shipping silently.
 *
 * `role` reuses `bootstrap.schema.ts`'s `portalRoleSchema` rather than redeclaring the six-role
 * union a second time in this file — `access-control.schema.ts` sets the same precedent for the
 * same reason (one union, asserted against the back end's `PortalRole` by
 * `back-end/test/me/bootstrap.contract.spec.ts`).
 *
 * `temporaryPassword` (on {@link userCreatedSchema}) is deliberately plain, exactly as
 * `tenant.schema.ts`'s own `tenantAdminCreatedSchema` documents: BACKLOG.md B-01 — "the
 * temporary password is shown once on screen". Never logged, never returned again by any other
 * route. See this task's completion report for why `POST /users` returns one at all, given
 * 03-API-CONTRACT.md §7's own text says otherwise — 07-DATA-PROTECTION.md §5's `routeOverrides`
 * (`"POST /users": "full", // returns a temporary password`, already live in
 * `config/data-protection.json` since T-017) and BACKLOG.md B-01 are the controlling references,
 * and T-030/T-034's own already-reviewed `tenantAdminCreatedSchema`/`countryAdminCreatedSchema`
 * precedent already ships the identical shape for the two links above this one in the same
 * delegation chain.
 */
import { z } from 'zod';
import { portalRoleSchema } from './bootstrap.schema';

/** `ck_portal_users_status`. */
export const USER_STATUSES = [
  'pending_activation',
  'active',
  'inactive',
  'locked',
  'suspended',
] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** One row of `GET /users` / `GET /users/:id`. Never a credential field — `password_hash` and
 * `mfa_secret_enc` are not columns this schema even names, let alone permits (T-035 TC-29). */
export const userSchema = z
  .object({
    id: z.number().int(),
    email: z.string(),
    displayName: z.string(),
    role: portalRoleSchema,
    countryId: z.number().int().nullable(),
    tenantId: z.number().int().nullable(),
    merchantId: z.number().int().nullable(),
    status: userStatusSchema,
    mustChangePassword: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type User = z.infer<typeof userSchema>;

/** 03-API-CONTRACT.md §1 — list responses carry `meta` alongside `data`. Declared locally per
 * `tenant.schema.ts`'s own precedent: no shared home for this API-wide envelope. */
export const userListMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .strict();

export const userListEnvelopeSchema = z
  .object({
    data: z.array(userSchema),
    meta: userListMetaSchema,
  })
  .strict();

export const userEnvelopeSchema = z.object({ data: userSchema }).strict();

/**
 * The request body of `POST /users`.
 *
 * `countryId`/`tenantId`/`merchantId` are all optional and all conditionally required
 * server-side, depending on which of the three the *caller's own role* needs to supply (never
 * derived from a fixed field list on this schema alone — AGENT-PROTOCOL R3: whichever of the
 * three matches the actor's *own* scope is silently overwritten server-side no matter what is
 * sent here; only the axis one level *below* the actor's own is ever actually read from the
 * body). See `UsersService.create()`'s own header for the worked table. No `password` field —
 * the server generates it (BACKLOG.md B-01).
 */
export const createUserRequestSchema = z
  .object({
    email: z.string().email().max(200),
    displayName: z.string().min(1).max(100),
    role: portalRoleSchema,
    countryId: z.number().int().optional(),
    tenantId: z.number().int().optional(),
    merchantId: z.number().int().optional(),
  })
  .strict();

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/**
 * The one-time credential response — `POST /users` and `POST /users/:id/reset-password`. Shown
 * once (BACKLOG.md B-01); never retrievable again by any other route (T-035 TC-16/TC-24,
 * T-046 TC-2/TC-3).
 */
export const userWithTemporaryPasswordSchema = userSchema
  .extend({ temporaryPassword: z.string() })
  .strict();

export type UserWithTemporaryPassword = z.infer<typeof userWithTemporaryPasswordSchema>;

export const userWithTemporaryPasswordEnvelopeSchema = z
  .object({ data: userWithTemporaryPasswordSchema })
  .strict();

/** The request body of `PATCH /users/:id`. `role` is deliberately absent — T-035 implementation
 * decision, see `UsersService.update()`'s own header: no role transition is permitted through
 * this route in v1, full stop, not only the escalating ones TC-28 names. A future task that adds
 * one back does so as a new, explicitly-audited route, not a field on this one. */
export const updateUserRequestSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
  })
  .strict();

export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/** `POST /users/:id/deactivate` and `POST /users/:id/reset-password` take no body. */
export const emptyRequestSchema = z.object({}).strict();
