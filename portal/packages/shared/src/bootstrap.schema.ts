/**
 * T-015 — the wire contract of `/me`, shared by the back end that produces it and the SPA that
 * consumes it (00-ARCHITECTURE.md §8: *"One Zod schema shared with the back end via
 * `packages/shared` → identical client and server validation"*).
 *
 * ### What this file is for
 *
 * `GET /me/bootstrap` is the single call that drives the entire UI — nav, permissions, dashboard
 * widgets, scope and the message catalogue (00-ARCHITECTURE.md §7). The SPA contains **no**
 * hard-coded menu and no hard-coded dashboard, so if this payload's shape drifts from what the
 * front end expects, the portal renders nothing and the failure surfaces as a blank screen rather
 * than as a type error. Declaring the shape once, here, and validating the real response against
 * it from the back end's own test suite is what turns that class of drift into a failing test in
 * whichever workspace caused it.
 *
 * ### Why every object is `.strict()`
 *
 * Not tidiness — it is the mechanical half of T-015 TC-15 (*"response scanned for sensitive keys:
 * no hash, no token, no other user's data"*). A `.strict()` object **rejects** an unrecognised
 * key instead of stripping it, so a future change that adds `passwordHash`, `mfaSecretEnc` or a
 * whole Sequelize row to any level of this payload fails the contract test rather than shipping.
 * A permissive schema would have validated such a response happily.
 *
 * ### What this file must not become
 *
 * A place to put behaviour. It is a description of bytes on a wire: no defaults that would let
 * the client invent a value the server never sent, no transforms, no coercion. `z.number()` and
 * not `z.coerce.number()` for the same reason — if the server ever sends `"12"` where the
 * contract says `12`, that is a bug worth failing on, not one worth papering over on the client.
 */
import { z } from 'zod';

/**
 * The six roles of 00-ARCHITECTURE.md §5. Declared here rather than imported from the back end
 * because the front end cannot import from `back-end/src`, and a second hand-written copy in the
 * SPA is exactly the drift this package exists to prevent.
 *
 * The back end's `PortalRole` (`back-end/src/database/portal-models/portal-user.model.ts`) is the
 * same union; `back-end/test/me/bootstrap.contract.spec.ts` asserts the two lists are identical,
 * so adding a seventh role in one place fails a test rather than silently halving the system.
 */
export const PORTAL_ROLES = [
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
] as const;

export const portalRoleSchema = z.enum(PORTAL_ROLES);

export type SharedPortalRole = z.infer<typeof portalRoleSchema>;

/**
 * The scope triple (00-ARCHITECTURE.md §5.1), exactly as the server enforces it.
 *
 * Every field is nullable because every field genuinely is: a `super_admin` has none of the
 * three, a `country_admin` has only `countryId`, and only a `merchant` user has `merchantId`.
 * This is **reporting**, not input — the SPA may use it to label the screen, never to send it
 * back. AGENT-PROTOCOL R3: the server reads the scope from the verified JWT and ignores any
 * client-supplied copy.
 */
export const bootstrapScopeSchema = z
  .object({
    countryId: z.number().int().nullable(),
    tenantId: z.number().int().nullable(),
    merchantId: z.number().int().nullable(),
  })
  .strict();

export type BootstrapScope = z.infer<typeof bootstrapScopeSchema>;

/**
 * The authenticated user, as 00-ARCHITECTURE.md §7 lists it — five fields and no more.
 *
 * Deliberately absent: `email`, `status`, `mustChangePassword`, any credential-adjacent field and
 * anything belonging to another user. `GET /me` is where a profile lives; the bootstrap payload
 * is what the UI needs to *render*, and the smaller it is the less there is to leak from a call
 * every session makes.
 */
export const bootstrapUserSchema = z
  .object({
    id: z.number().int(),
    displayName: z.string(),
    role: portalRoleSchema,
    /** BCP-47-ish tag. Never null: the server substitutes `'en'` when the column is null. */
    locale: z.string(),
    /** IANA zone, or `null` when the user has never set one. */
    timezone: z.string().nullable(),
  })
  .strict();

export type BootstrapUser = z.infer<typeof bootstrapUserSchema>;

/**
 * One node of the nav tree.
 *
 * `children` makes the type recursive, which Zod expresses with `z.lazy` and TypeScript cannot
 * infer through — hence the hand-written interface below and the explicit `z.ZodType` annotation.
 *
 * **An orphan is never present.** The server drops any row whose parent is missing or disabled
 * rather than promoting it to the top level (T-015 implementation note 2, TC-8), so a client can
 * treat "present in this array" as "the whole ancestor chain is enabled" without checking.
 */
export interface BootstrapNavItem {
  readonly key: string;
  readonly label: string;
  readonly icon: string | null;
  readonly path: string;
  readonly children: readonly BootstrapNavItem[];
}

export const bootstrapNavItemSchema: z.ZodType<BootstrapNavItem> = z.lazy(() =>
  z
    .object({
      key: z.string(),
      label: z.string(),
      icon: z.string().nullable(),
      path: z.string(),
      children: z.array(bootstrapNavItemSchema),
    })
    .strict(),
);

/**
 * One dashboard widget. `config` is free-form by design — `role_dashboard_widgets.widget_config`
 * is a `text` column holding JSON whose contents the front end (T-023) interprets per widget key.
 *
 * A malformed or non-object stored value is normalised to `{}` by the server rather than failing
 * the request (T-015 implementation note 4, TC-11), so this is `z.record`, never `z.unknown()`:
 * the client is guaranteed an object it can index.
 */
export const bootstrapWidgetSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    config: z.record(z.unknown()),
  })
  .strict();

export type BootstrapWidget = z.infer<typeof bootstrapWidgetSchema>;

/**
 * The permission matrix, flattened to `{ entity: actions[] }` (T-015 implementation note 3).
 *
 * This is a **rendering** aid — it decides which buttons exist, never whether an operation is
 * allowed. 00-ARCHITECTURE.md §7: *"the matching server-side permission row is what actually
 * blocks the API. Hiding a link never stands alone as a control."*
 */
export const bootstrapPermissionsSchema = z.record(z.array(z.string()));

export type BootstrapPermissions = z.infer<typeof bootstrapPermissionsSchema>;

/** The `system_messages` catalogue: `{ MESSAGE_KEY: 'localised text' }` (01-DATABASE.md §5.4). */
export const bootstrapMessagesSchema = z.record(z.string());

/** The payload of `GET /me/bootstrap`, inside the `{ data }` envelope. */
export const bootstrapSchema = z
  .object({
    user: bootstrapUserSchema,
    scope: bootstrapScopeSchema,
    nav: z.array(bootstrapNavItemSchema),
    permissions: bootstrapPermissionsSchema,
    widgets: z.array(bootstrapWidgetSchema),
    messages: bootstrapMessagesSchema,
  })
  .strict();

export type Bootstrap = z.infer<typeof bootstrapSchema>;

/**
 * The whole HTTP body of `GET /me/bootstrap`.
 *
 * 03-API-CONTRACT.md §1 puts every success payload inside `{ "data": … }`, and `/me` is not an
 * exception to it — 00-ARCHITECTURE.md §7's snippet shows the payload, not the envelope. Both
 * schemas are exported so a caller can validate whichever it is holding.
 */
export const bootstrapEnvelopeSchema = z.object({ data: bootstrapSchema }).strict();

/** The payload of `GET /me` — the caller's own profile, and only ever the caller's own. */
export const meProfileSchema = z
  .object({
    id: z.number().int(),
    email: z.string(),
    displayName: z.string(),
    role: portalRoleSchema,
    scope: bootstrapScopeSchema,
    locale: z.string(),
    timezone: z.string().nullable(),
    status: z.string(),
    mustChangePassword: z.boolean(),
    /** ISO-8601, or `null` before the first successful login. */
    lastLoginAt: z.string().nullable(),
  })
  .strict();

export type MeProfile = z.infer<typeof meProfileSchema>;

export const meProfileEnvelopeSchema = z.object({ data: meProfileSchema }).strict();

/**
 * The request body of `PATCH /me` — **three fields, and nothing else, ever**.
 *
 * This is the single most security-relevant declaration in this file. 03-API-CONTRACT.md §3:
 * *"`displayName`, `preferredLocale`, `preferredTimezone` **only** — role and scope are not
 * writable here."* A `role` or `tenantId` accepted here would be a self-service privilege
 * escalation from any account in the system.
 *
 * `.strict()` is what makes the client half of that real: `updateMeSchema.parse({ role: … })`
 * throws rather than quietly dropping the key, so a form that tries to send one fails in
 * development. The server half does not rely on this file at all — it uses a `class-validator`
 * DTO under `forbidNonWhitelisted`, which answers **400** (T-015 TC-16/TC-17). Two independent
 * declarations of the same rule, in the two places it has to hold;
 * `back-end/test/me/me.dto.spec.ts` asserts they name exactly the same fields so they cannot
 * drift apart.
 */
export const updateMeSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    preferredLocale: z
      .string()
      .max(10)
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
      .optional(),
    preferredTimezone: z.string().min(1).max(60).optional(),
  })
  .strict();

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

/**
 * The `Cache-Control` value `GET /me/bootstrap` sends (T-015 implementation note 7).
 *
 * `private` keeps a shared cache from ever storing one user's nav and serving it to another;
 * `no-cache` still permits the browser to keep a copy but forces revalidation against the `ETag`
 * on every use, which is what makes a permission change take effect on the next request rather
 * than at the end of some TTL. Exported so the SPA's API client can assert it rather than assume
 * it.
 */
export const BOOTSTRAP_CACHE_CONTROL = 'private, no-cache';
