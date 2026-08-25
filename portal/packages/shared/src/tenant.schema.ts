/**
 * T-034 — the wire contract of `/tenants`, shared by the back end that produces it and the SPA
 * that consumes it (00-ARCHITECTURE.md §8). Same discipline `country.schema.ts` states in full:
 * bytes on the wire only, no defaults the server never sent, no coercion, `.strict()` everywhere
 * so an unexpected key fails the contract test rather than shipping silently.
 *
 * `temporaryPassword` (on {@link tenantAdminCreatedSchema}) is the one field that is
 * *deliberately* plain here and in the response the server sends — BACKLOG.md B-01: "the
 * temporary password is shown once on screen". Never logged, never returned again by any other
 * route.
 */
import { z } from 'zod';

/** `reward_config.tenants.status` — `ck_tenants_status`. */
export const TENANT_STATUSES = ['pending_provisioning', 'active', 'inactive', 'suspended'] as const;
export const tenantStatusSchema = z.enum(TENANT_STATUSES);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

/** One row of `GET /tenants` / `GET /tenants/:id`. */
export const tenantSchema = z
  .object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    countryId: z.number().int(),
    schemaPrefix: z.string().nullable(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    status: tenantStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type Tenant = z.infer<typeof tenantSchema>;

/** 03-API-CONTRACT.md §1 — list responses carry `meta` alongside `data`. Declared locally per
 * `country.schema.ts`'s own precedent: no shared home for this API-wide envelope. */
export const tenantListMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .strict();

export const tenantListEnvelopeSchema = z
  .object({
    data: z.array(tenantSchema),
    meta: tenantListMetaSchema,
  })
  .strict();

export const tenantEnvelopeSchema = z.object({ data: tenantSchema }).strict();

/**
 * The request body of `POST /tenants/:id/admins`, and the nested `admin` field of
 * `POST /tenants`.
 *
 * `password` is never here — the server generates it (BACKLOG.md B-01), never an admin. No
 * `tenantId`/`countryId` either — both are derived server-side (implementation note 2).
 */
export const createTenantAdminRequestSchema = z
  .object({
    email: z.string().email().max(200),
    displayName: z.string().min(1).max(100),
  })
  .strict();

export type CreateTenantAdminRequest = z.infer<typeof createTenantAdminRequestSchema>;

/**
 * The request body of `POST /tenants`. No `countryId` — implementation note 2 / AGENT-PROTOCOL
 * R3: taken from the actor's own scope, never from the request body.
 */
export const createTenantRequestSchema = z
  .object({
    code: z.string().min(1).max(20),
    name: z.string().min(1).max(100),
    schemaPrefix: z.string().min(1).max(10).optional(),
    contactEmail: z.string().email().max(255).optional(),
    contactPhone: z.string().min(1).max(20).optional(),
    admin: createTenantAdminRequestSchema.optional(),
  })
  .strict();

export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;

/**
 * The response to a successful admin-creation call — `POST /tenants/:id/admins`, and the
 * `admin` field of `POST /tenants`'s response when `admin` was supplied in the request.
 *
 * Shown once (B-01); never retrievable again by any other route.
 */
export const tenantAdminCreatedSchema = z
  .object({
    id: z.number().int(),
    email: z.string(),
    displayName: z.string(),
    role: z.literal('tenant_admin'),
    tenantId: z.number().int(),
    temporaryPassword: z.string(),
  })
  .strict();

export type TenantAdminCreated = z.infer<typeof tenantAdminCreatedSchema>;

export const createTenantResponseSchema = z
  .object({
    tenant: tenantSchema,
    admin: tenantAdminCreatedSchema.nullable(),
  })
  .strict();

export type CreateTenantResponse = z.infer<typeof createTenantResponseSchema>;

export const createTenantEnvelopeSchema = z.object({ data: createTenantResponseSchema }).strict();

export const tenantAdminCreatedEnvelopeSchema = z
  .object({ data: tenantAdminCreatedSchema })
  .strict();

/** The request body of `PATCH /tenants/:id`. No `code`/`countryId` — see the back end's own
 * `update-tenant.dto.ts` header for why neither is ever settable this way. */
export const updateTenantRequestSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    schemaPrefix: z.string().min(1).max(10).optional(),
    contactEmail: z.string().email().max(255).optional(),
    contactPhone: z.string().min(1).max(20).optional(),
    status: tenantStatusSchema.optional(),
  })
  .strict();

export type UpdateTenantRequest = z.infer<typeof updateTenantRequestSchema>;

/** One row of the "Tenants without a budget ceiling" Country Admin dashboard widget
 * (implementation note 7, TC-28). `GET /tenants/without-budget-ceiling`. */
export const tenantWithoutCeilingSchema = z
  .object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    countryId: z.number().int(),
  })
  .strict();

export type TenantWithoutCeiling = z.infer<typeof tenantWithoutCeilingSchema>;

export const tenantWithoutCeilingListEnvelopeSchema = z
  .object({ data: z.array(tenantWithoutCeilingSchema) })
  .strict();

// --- Budget ceilings (11-BUDGETS-AND-LIMITS.md §8) --------------------------------------------

/** `ck_tbc_unit`. */
export const TENANT_BUDGET_CEILING_UNIT_TYPES = ['currency', 'points', 'voucher'] as const;
export const tenantBudgetCeilingUnitTypeSchema = z.enum(TENANT_BUDGET_CEILING_UNIT_TYPES);
export type TenantBudgetCeilingUnitType = z.infer<typeof tenantBudgetCeilingUnitTypeSchema>;

/** One `tenant_budget_ceilings` row. `maxCampaignBudget`/`warnAboveAmount` are decimal
 * **strings** — "money never crosses a boundary as a float" (the back end model's own header). */
export const budgetCeilingSchema = z
  .object({
    id: z.number().int(),
    tenantId: z.number().int(),
    unitType: tenantBudgetCeilingUnitTypeSchema,
    unitCode: z.string(),
    maxCampaignBudget: z.string(),
    warnAboveAmount: z.string().nullable(),
    status: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type BudgetCeiling = z.infer<typeof budgetCeilingSchema>;

export const budgetCeilingListEnvelopeSchema = z
  .object({ data: z.array(budgetCeilingSchema) })
  .strict();

/** `PUT /tenants/:id/budget-ceilings` request body — one unit per call (upsert), never a
 * partial patch (`upsert-budget-ceiling.dto.ts`'s own header). */
export const upsertBudgetCeilingRequestSchema = z
  .object({
    unitType: tenantBudgetCeilingUnitTypeSchema,
    unitCode: z.string().min(1).max(10),
    maxCampaignBudget: z.string().min(1),
    warnAboveAmount: z.string().optional(),
  })
  .strict();

export type UpsertBudgetCeilingRequest = z.infer<typeof upsertBudgetCeilingRequestSchema>;
