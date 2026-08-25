/**
 * T-033 — the wire contract of `/admin/access-control`, shared by the back end that produces it
 * and the SPA that consumes it (00-ARCHITECTURE.md §8: "One Zod schema shared with the back end
 * via `packages/shared` → identical client and server validation").
 *
 * Reuses `bootstrap.schema.ts`'s `portalRoleSchema`, `bootstrapNavItemSchema`,
 * `bootstrapWidgetSchema` and `bootstrapPermissionsSchema` for `POST /preview`'s response — it is
 * literally the same shape `GET /me/bootstrap` renders from, minus `user`/`scope`/`messages`
 * (`access-control-response.dto.ts`'s own `PreviewResponse` comment).
 */
import { z } from 'zod';
import {
  bootstrapNavItemSchema,
  bootstrapPermissionsSchema,
  bootstrapWidgetSchema,
  portalRoleSchema,
} from './bootstrap.schema';

export const roleSummarySchema = z
  .object({ role: portalRoleSchema, userCount: z.number().int().nonnegative() })
  .strict();

export type RoleSummary = z.infer<typeof roleSummarySchema>;

export const roleSummaryListEnvelopeSchema = z
  .object({ data: z.array(roleSummarySchema) })
  .strict();

export const entityCatalogueEntrySchema = z
  .object({
    entity: z.string(),
    actions: z.array(z.string()),
    /** The subset of `actions` locked to `super_admin` — the UI renders these cells disabled with
     * an explanatory tooltip for every other role (implementation note 3). */
    protectedActions: z.array(z.string()),
  })
  .strict();

export type EntityCatalogueEntry = z.infer<typeof entityCatalogueEntrySchema>;

export const entityCatalogueListEnvelopeSchema = z
  .object({ data: z.array(entityCatalogueEntrySchema) })
  .strict();

// --- nav ---------------------------------------------------------------------------------------

export const navConfigItemSchema = z
  .object({
    navKey: z.string(),
    label: z.string(),
    icon: z.string().nullable(),
    path: z.string(),
    parentNavKey: z.string().nullable(),
    sortOrder: z.number().int(),
    enabled: z.boolean(),
  })
  .strict();

export type NavConfigItem = z.infer<typeof navConfigItemSchema>;

export const navConfigResponseSchema = z
  .object({
    role: portalRoleSchema,
    version: z.number().int().nonnegative(),
    items: z.array(navConfigItemSchema),
  })
  .strict();

export type NavConfigResponse = z.infer<typeof navConfigResponseSchema>;

export const navConfigEnvelopeSchema = z.object({ data: navConfigResponseSchema }).strict();

/** `navKey` must be lower_snake_case, starting with a letter — mirrors
 * `nav-config.dto.ts`'s `NAV_KEY_PATTERN`. */
const NAV_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

export const navConfigItemRequestSchema = z
  .object({
    navKey: z.string().regex(NAV_KEY_PATTERN),
    label: z.string().min(1),
    icon: z.string().nullable().optional(),
    path: z.string().min(1),
    parentNavKey: z.string().nullable().optional(),
    sortOrder: z.number().int().min(0),
    enabled: z.boolean(),
  })
  .strict();

export type NavConfigItemRequest = z.infer<typeof navConfigItemRequestSchema>;

/** `PUT /admin/access-control/nav/:role` — full replace (implementation note 5). */
export const putNavConfigRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    items: z.array(navConfigItemRequestSchema).max(100),
  })
  .strict();

export type PutNavConfigRequest = z.infer<typeof putNavConfigRequestSchema>;

// --- widgets -----------------------------------------------------------------------------------

const WIDGET_KEY_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

export const widgetConfigItemSchema = z
  .object({
    widgetKey: z.string(),
    label: z.string(),
    config: z.record(z.unknown()),
    sortOrder: z.number().int(),
    enabled: z.boolean(),
  })
  .strict();

export type WidgetConfigItem = z.infer<typeof widgetConfigItemSchema>;

export const widgetConfigResponseSchema = z
  .object({
    role: portalRoleSchema,
    version: z.number().int().nonnegative(),
    items: z.array(widgetConfigItemSchema),
  })
  .strict();

export type WidgetConfigResponse = z.infer<typeof widgetConfigResponseSchema>;

export const widgetConfigEnvelopeSchema = z.object({ data: widgetConfigResponseSchema }).strict();

export const widgetConfigItemRequestSchema = z
  .object({
    widgetKey: z.string().regex(WIDGET_KEY_PATTERN),
    label: z.string().min(1),
    config: z.record(z.unknown()).optional(),
    sortOrder: z.number().int().min(0),
    enabled: z.boolean(),
  })
  .strict();

export type WidgetConfigItemRequest = z.infer<typeof widgetConfigItemRequestSchema>;

/** `PUT /admin/access-control/widgets/:role` — full replace. */
export const putWidgetConfigRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    items: z.array(widgetConfigItemRequestSchema).max(100),
  })
  .strict();

export type PutWidgetConfigRequest = z.infer<typeof putWidgetConfigRequestSchema>;

// --- permissions ---------------------------------------------------------------------------------

export const permissionsResponseSchema = z
  .object({
    role: portalRoleSchema,
    version: z.number().int().nonnegative(),
    permissions: bootstrapPermissionsSchema,
  })
  .strict();

export type PermissionsResponse = z.infer<typeof permissionsResponseSchema>;

export const permissionsEnvelopeSchema = z.object({ data: permissionsResponseSchema }).strict();

/** `PUT /admin/access-control/permissions/:role` — full replace (implementation note 5). Cell
 * validity against the entity catalogue (TC-23) is enforced server-side against
 * `GET /admin/access-control/entities`, not re-declared as a Zod union here — the catalogue is
 * itself an API response, not a compile-time constant the SPA can import. */
export const putPermissionsRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    permissions: bootstrapPermissionsSchema,
  })
  .strict();

export type PutPermissionsRequest = z.infer<typeof putPermissionsRequestSchema>;

// --- reorder -------------------------------------------------------------------------------------

export const reorderItemSchema = z
  .object({ key: z.string().min(1), sortOrder: z.number().int().min(0) })
  .strict();

export const reorderRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    order: z.array(reorderItemSchema).max(100),
  })
  .strict();

export type ReorderRequest = z.infer<typeof reorderRequestSchema>;

// --- preview -----------------------------------------------------------------------------------

/** `POST /admin/access-control/preview` — implementation note 6. `nav`/`permissions`/`widgets`
 * are the caller's uncommitted draft; whichever is omitted previews the role's current,
 * already-committed rows instead. */
export const previewRequestSchema = z
  .object({
    role: portalRoleSchema,
    nav: z.array(navConfigItemRequestSchema).optional(),
    permissions: bootstrapPermissionsSchema.optional(),
    widgets: z.array(widgetConfigItemRequestSchema).optional(),
  })
  .strict();

export type PreviewRequest = z.infer<typeof previewRequestSchema>;

export const previewResponseSchema = z
  .object({
    role: portalRoleSchema,
    nav: z.array(bootstrapNavItemSchema),
    permissions: bootstrapPermissionsSchema,
    widgets: z.array(bootstrapWidgetSchema),
  })
  .strict();

export type PreviewResponse = z.infer<typeof previewResponseSchema>;

export const previewEnvelopeSchema = z.object({ data: previewResponseSchema }).strict();
