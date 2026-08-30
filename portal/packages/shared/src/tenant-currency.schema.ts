/**
 * T-126 — the wire contract of `/tenants/:id/currencies` (13-REWARD-MASTER-VALUE-SOURCES.md §4).
 * A separate file from `tenant.schema.ts` (T-034's own, `done`) rather than an addition to it —
 * same "own file per new endpoint surface, no shared file two tasks edit at once" discipline
 * `05-EXECUTION-PLAN.md` §3 states for `packages/shared`.
 *
 * `countries.currency_code` (`country.schema.ts`) is untouched — this is additive, a tenant's
 * *own* list on top of its country's single default.
 */
import { z } from 'zod';

/** `ck_tc_status`. */
export const TENANT_CURRENCY_STATUSES = ['active', 'inactive'] as const;
export const tenantCurrencyStatusSchema = z.enum(TENANT_CURRENCY_STATUSES);
export type TenantCurrencyStatus = z.infer<typeof tenantCurrencyStatusSchema>;

/** One row of `GET /tenants/:id/currencies`. */
export const tenantCurrencySchema = z
  .object({
    id: z.number().int(),
    tenantId: z.number().int(),
    currencyCode: z.string().length(3),
    isDefault: z.boolean(),
    status: tenantCurrencyStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type TenantCurrency = z.infer<typeof tenantCurrencySchema>;

export const tenantCurrencyListEnvelopeSchema = z
  .object({ data: z.array(tenantCurrencySchema) })
  .strict();

export const tenantCurrencyEnvelopeSchema = z.object({ data: tenantCurrencySchema }).strict();

/** `POST /tenants/:id/currencies`. `isDefault` defaults to `false` server-side when omitted. */
export const createTenantCurrencyRequestSchema = z
  .object({
    currencyCode: z.string().length(3),
    isDefault: z.boolean().optional(),
  })
  .strict();

export type CreateTenantCurrencyRequest = z.infer<typeof createTenantCurrencyRequestSchema>;

/** `PATCH /tenants/:id/currencies/:currencyId`. `currencyCode` is immutable once created — never
 * in this schema (the back end's own `update-tenant-currency.dto.ts` header explains why). */
export const updateTenantCurrencyRequestSchema = z
  .object({
    status: tenantCurrencyStatusSchema.optional(),
  })
  .strict();

export type UpdateTenantCurrencyRequest = z.infer<typeof updateTenantCurrencyRequestSchema>;
