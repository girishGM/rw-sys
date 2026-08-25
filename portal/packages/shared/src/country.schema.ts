/**
 * T-030 — the wire contract of `/countries`, shared by the back end that produces it and the SPA
 * that consumes it (00-ARCHITECTURE.md §8: "One Zod schema shared with the back end via
 * `packages/shared` → identical client and server validation").
 *
 * ### Scope
 *
 * This file describes bytes on the wire only — the same discipline `bootstrap.schema.ts` states
 * in full: no defaults the server never sent, no coercion, `.strict()` everywhere so an
 * unexpected key (a hash, a token, another user's data) fails the contract test rather than
 * shipping silently.
 *
 * `temporaryPassword` (on {@link countryAdminCreatedSchema}) is the one field that is
 * *deliberately* plain here and in the response the server sends — BACKLOG.md B-01: "the
 * temporary password is shown once on screen". It is never logged (T017_002's
 * `dto.CreateUserResponse.temporaryPassword` policy row: `log_treatment: omit`) and never
 * returned again by any other route.
 */
import { z } from 'zod';

/** `reward_config.countries.status` — `ck_countries_status`. */
export const COUNTRY_STATUSES = ['active', 'inactive'] as const;
export const countryStatusSchema = z.enum(COUNTRY_STATUSES);
export type CountryStatus = z.infer<typeof countryStatusSchema>;

/** One row of `GET /countries` / `GET /countries/:id`. */
export const countrySchema = z
  .object({
    id: z.number().int(),
    /** ISO-3166-1 alpha-2, always uppercase. */
    code: z.string().length(2),
    name: z.string(),
    /** IANA time zone identifier. */
    timezone: z.string(),
    /** ISO-4217, always uppercase. */
    currencyCode: z.string().length(3),
    dialingCode: z.string(),
    isHq: z.boolean(),
    status: countryStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type Country = z.infer<typeof countrySchema>;

/** 03-API-CONTRACT.md §1 — list responses carry `meta` alongside `data`. */
export const listMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .strict();

export const countryListEnvelopeSchema = z
  .object({
    data: z.array(countrySchema),
    meta: listMetaSchema,
  })
  .strict();

export const countryEnvelopeSchema = z.object({ data: countrySchema }).strict();

/**
 * The request body of `POST /countries/:id/admins`, and the nested `admin` field of
 * `POST /countries`.
 *
 * `password` is never here — 00-ARCHITECTURE.md/BACKLOG B-01: the server generates it, never an
 * admin.
 */
export const createCountryAdminRequestSchema = z
  .object({
    email: z.string().email().max(200),
    displayName: z.string().min(1).max(100),
  })
  .strict();

export type CreateCountryAdminRequest = z.infer<typeof createCountryAdminRequestSchema>;

/** The request body of `POST /countries`. */
export const createCountryRequestSchema = z
  .object({
    code: z.string().length(2),
    name: z.string().min(1).max(100),
    timezone: z.string().min(1).max(50),
    currencyCode: z.string().length(3),
    dialingCode: z.string().min(1).max(5),
    isHq: z.boolean().optional(),
    admin: createCountryAdminRequestSchema.optional(),
  })
  .strict();

export type CreateCountryRequest = z.infer<typeof createCountryRequestSchema>;

/**
 * The response to a successful admin-creation call — `POST /countries/:id/admins`, and the
 * `admin` field of `POST /countries`'s response when `admin` was supplied in the request.
 *
 * Shown once (B-01); never retrievable again by any other route (T-046 owns the general-purpose
 * mechanism this pattern anticipates for `/users`).
 */
export const countryAdminCreatedSchema = z
  .object({
    id: z.number().int(),
    email: z.string(),
    displayName: z.string(),
    role: z.literal('country_admin'),
    countryId: z.number().int(),
    temporaryPassword: z.string(),
  })
  .strict();

export type CountryAdminCreated = z.infer<typeof countryAdminCreatedSchema>;

export const createCountryResponseSchema = z
  .object({
    country: countrySchema,
    admin: countryAdminCreatedSchema.nullable(),
  })
  .strict();

export type CreateCountryResponse = z.infer<typeof createCountryResponseSchema>;

export const createCountryEnvelopeSchema = z.object({ data: createCountryResponseSchema }).strict();

export const countryAdminCreatedEnvelopeSchema = z
  .object({ data: countryAdminCreatedSchema })
  .strict();

/** The request body of `PATCH /countries/:id`. */
export const updateCountryRequestSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    timezone: z.string().min(1).max(50).optional(),
    currencyCode: z.string().length(3).optional(),
    dialingCode: z.string().min(1).max(5).optional(),
    isHq: z.boolean().optional(),
    status: countryStatusSchema.optional(),
    /**
     * Required to actually deactivate a country that still has active tenants
     * (implementation note 7 — "surface a warning ... require explicit confirmation"). Ignored
     * for every other change.
     */
    confirm: z.boolean().optional(),
  })
  .strict();

export type UpdateCountryRequest = z.infer<typeof updateCountryRequestSchema>;

/** One tenant, as summarised for `GET /countries/:id/summary`'s deactivation-warning list. */
export const countryTenantSummarySchema = z
  .object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    status: z.string(),
  })
  .strict();

/** `GET /countries/:id/summary`. */
export const countrySummarySchema = z
  .object({
    countryId: z.number().int(),
    tenantCount: z.number().int(),
    activeTenantCount: z.number().int(),
    campaignCount: z.number().int(),
    tenants: z.array(countryTenantSummarySchema),
  })
  .strict();

export type CountrySummary = z.infer<typeof countrySummarySchema>;

export const countrySummaryEnvelopeSchema = z.object({ data: countrySummarySchema }).strict();
