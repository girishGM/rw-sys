/**
 * T-036 — the wire contract of `/merchants`, shared by the back end that produces it and the SPA
 * that consumes it (00-ARCHITECTURE.md §8). Same discipline every other `*.schema.ts` in this
 * package states in full: bytes on the wire only, no defaults the server never sent, no
 * coercion, `.strict()` everywhere so an unexpected key fails the contract test rather than
 * shipping silently.
 *
 * `latitude`/`longitude`/`commissionRate` are decimal **strings**, never `number` — the same
 * "money/precision never crosses a boundary as a float" discipline `tenant.schema.ts`'s own
 * `budgetCeilingSchema` states, for the same reason: the back end reads `decimal(...)` columns
 * back from Postgres as strings and never coerces them (`merchant-store.model.ts`/
 * `merchant-activity.model.ts`'s own headers).
 */
import { z } from 'zod';

/** `ck_m_status`. */
export const MERCHANT_STATUSES = ['active', 'inactive', 'suspended'] as const;
export const merchantStatusSchema = z.enum(MERCHANT_STATUSES);
export type MerchantStatus = z.infer<typeof merchantStatusSchema>;

/** One row of `GET /merchants` / `GET /merchants/:id`. */
export const merchantSchema = z
  .object({
    id: z.number().int(),
    tenantId: z.number().int(),
    merchantCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    website: z.string().nullable(),
    countryCode: z.string(),
    status: merchantStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type Merchant = z.infer<typeof merchantSchema>;

/** 03-API-CONTRACT.md §1 — list responses carry `meta` alongside `data`. Declared locally per
 * `tenant.schema.ts`'s own precedent: no shared home for this API-wide envelope. */
export const merchantListMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .strict();

export const merchantListEnvelopeSchema = z
  .object({
    data: z.array(merchantSchema),
    meta: merchantListMetaSchema,
  })
  .strict();

export const merchantEnvelopeSchema = z.object({ data: merchantSchema }).strict();

/**
 * The request body of `POST /merchants`. No `tenantId` — implementation note 2 / AGENT-PROTOCOL
 * R3: taken from the actor's own scope, never from the request body. `countryCode` *is* here —
 * implementation note 3: validated server-side against the actor's own tenant's country, not
 * derived, because `merchants.country_code` carries no FK back to `countries` for the server to
 * derive it from any other way.
 */
export const createMerchantRequestSchema = z
  .object({
    merchantCode: z.string().min(1).max(50),
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    contactEmail: z.string().email().max(255).optional(),
    contactPhone: z.string().min(1).max(20).optional(),
    website: z.string().max(500).optional(),
    countryCode: z.string().length(2),
  })
  .strict();

export type CreateMerchantRequest = z.infer<typeof createMerchantRequestSchema>;

/** `POST /merchants` responds with the created merchant alone (unlike `tenant.schema.ts`'s
 * `createTenantResponseSchema`, which also carries an admin — this task creates no user), so it
 * reuses {@link merchantEnvelopeSchema} rather than declaring a near-identical second schema. */

/** The request body of `PATCH /merchants/:id`. No `merchantCode`/`tenantId`/`countryCode` — see
 * the back end's own `update-merchant.dto.ts` header for why none of the three is ever settable
 * this way. `confirm` — implementation note 7: required to deactivate a merchant that
 * participates in an active campaign (TC-20). */
export const updateMerchantRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    contactEmail: z.string().email().max(255).optional(),
    contactPhone: z.string().min(1).max(20).optional(),
    website: z.string().max(500).optional(),
    status: merchantStatusSchema.optional(),
    confirm: z.boolean().optional(),
  })
  .strict();

export type UpdateMerchantRequest = z.infer<typeof updateMerchantRequestSchema>;

/** One `merchant_stores` row — `GET`/`POST /merchants/:id/stores`. */
export const merchantStoreSchema = z
  .object({
    id: z.number().int(),
    tenantId: z.number().int(),
    merchantId: z.number().int(),
    storeCode: z.string(),
    name: z.string(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
    region: z.string().nullable(),
    latitude: z.string().nullable(),
    longitude: z.string().nullable(),
    status: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type MerchantStore = z.infer<typeof merchantStoreSchema>;

export const merchantStoreListEnvelopeSchema = z
  .object({ data: z.array(merchantStoreSchema) })
  .strict();

export const merchantStoreEnvelopeSchema = z.object({ data: merchantStoreSchema }).strict();

/** `POST /merchants/:id/stores` request body. No `tenantId`/`merchantId` — both come from the
 * URL and the actor's own scope. */
export const createMerchantStoreRequestSchema = z
  .object({
    storeCode: z.string().min(1).max(50),
    name: z.string().min(1).max(200),
    address: z.string().max(500).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    postalCode: z.string().max(20).optional(),
    region: z.string().max(50).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict();

export type CreateMerchantStoreRequest = z.infer<typeof createMerchantStoreRequestSchema>;

/** One `merchant_activities` row — `GET`/`POST /merchants/:id/activities`. */
export const merchantActivitySchema = z
  .object({
    id: z.number().int(),
    tenantId: z.number().int(),
    merchantId: z.number().int(),
    activityId: z.number().int(),
    storeId: z.number().int().nullable(),
    commissionRate: z.string().nullable(),
    status: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type MerchantActivity = z.infer<typeof merchantActivitySchema>;

export const merchantActivityListEnvelopeSchema = z
  .object({ data: z.array(merchantActivitySchema) })
  .strict();

export const merchantActivityEnvelopeSchema = z.object({ data: merchantActivitySchema }).strict();

/**
 * `POST /merchants/:id/activities` request body (implementation note 4). `storeId` omitted
 * means "tenant-wide" — never `null` on the wire. `commissionRate` is a `number` here (unlike
 * the response's decimal string): the request carries a percentage a human typed, 0–100 with at
 * most 2 decimals, and the back end is what converts it to the exact `decimal(5,2)` column
 * string (`merchants.validators.ts#commissionRateToColumnString`) — the request's own shape has
 * no float-precision hazard at this magnitude the way a large money amount would.
 */
export const createMerchantActivityRequestSchema = z
  .object({
    activityId: z.number().int().positive(),
    storeId: z.number().int().positive().optional(),
    commissionRate: z.number().min(0).max(100).optional(),
  })
  .strict();

export type CreateMerchantActivityRequest = z.infer<typeof createMerchantActivityRequestSchema>;

/** One row of `GET /merchants/:id/active-campaigns` — the deactivation-warning data source
 * (implementation note 7, TC-20). */
export const merchantActiveCampaignSchema = z
  .object({
    id: z.number().int(),
    campaignCode: z.string(),
    name: z.string(),
    status: z.string(),
  })
  .strict();

export type MerchantActiveCampaign = z.infer<typeof merchantActiveCampaignSchema>;

export const merchantActiveCampaignListEnvelopeSchema = z
  .object({ data: z.array(merchantActiveCampaignSchema) })
  .strict();
