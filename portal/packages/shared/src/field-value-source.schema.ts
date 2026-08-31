/**
 * T-121 — the wire contract for the two field value-source registries
 * (`13-REWARD-MASTER-VALUE-SOURCES.md` §3).
 *
 * Its own file, not an addition to `rule.schema.ts` or `reward.schema.ts`, per the task's
 * implementation note 5: a value source is used by *both* a rule field and a reward field, so
 * hanging it off either one would force the other to import it and create a circular (or
 * duplicated) dependency between the two domain schemas.
 *
 * ### `authConfig` appears in the request schema and never in the response schema
 *
 * That asymmetry is the point, not an oversight. A caller may *write* a credential (Super Admin
 * only, `POST`/`PATCH`); nothing may ever read one back over HTTP. The response schemas below are
 * `.strict()`, so a future change that starts leaking `authConfig` into a response body fails
 * these schemas rather than shipping quietly — see `field-value-source-response.dto.ts` for the
 * server-side half of the same guarantee.
 */
import { z } from 'zod';

/** `field_context_providers.status` — `ck_fcp_status` (T121_001). */
export const FIELD_CONTEXT_PROVIDER_STATUSES = ['active', 'inactive'] as const;

/**
 * `field_api_lookup_providers.status` — `ck_falp_status` (T121_001). `planned` means "registered,
 * but its real endpoint/auth/response keys are not confirmed yet": a field may be authored against
 * it, but T-123 declines the runtime lookup and T-125 renders that state instead of spinning.
 */
export const FIELD_API_LOOKUP_PROVIDER_STATUSES = ['active', 'planned', 'inactive'] as const;

/** `ck_falp_http_method` (T121_001). */
export const FIELD_API_LOOKUP_HTTP_METHODS = ['GET', 'POST'] as const;

/** `ck_falp_auth_type` (T121_001). Open by design — see that migration's header. */
export const FIELD_API_LOOKUP_AUTH_TYPES = ['none', 'api_key', 'bearer', 'mtls'] as const;

export const fieldContextProviderStatusSchema = z.enum(FIELD_CONTEXT_PROVIDER_STATUSES);
export const fieldApiLookupProviderStatusSchema = z.enum(FIELD_API_LOOKUP_PROVIDER_STATUSES);
export const fieldApiLookupHttpMethodSchema = z.enum(FIELD_API_LOOKUP_HTTP_METHODS);
export const fieldApiLookupAuthTypeSchema = z.enum(FIELD_API_LOOKUP_AUTH_TYPES);

const PROVIDER_CODE_MAX = 50;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 500;
const ENDPOINT_URL_MAX = 500;
const RESPONSE_KEY_MAX = 100;

/**
 * A provider code is an immutable, machine-readable identifier — upper snake case only. Constrained
 * here rather than left free text because T-122 stores it as the value-source reference on a rule
 * field, and T-123 dispatches on it.
 */
export const providerCodeSchema = z
  .string()
  .min(2)
  .max(PROVIDER_CODE_MAX)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be upper snake case, e.g. PRODUCT_CATALOG');

/** `GET /field-context-providers`. Read-only reference data, reachable by every role. */
export const fieldContextProviderSchema = z
  .object({
    id: z.number().int(),
    providerCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
  })
  .strict();

export type FieldContextProvider = z.infer<typeof fieldContextProviderSchema>;

export const fieldContextProviderEnvelopeSchema = z
  .object({ data: fieldContextProviderSchema })
  .strict();

export const fieldContextProviderListEnvelopeSchema = z
  .object({ data: z.array(fieldContextProviderSchema) })
  .strict();

/**
 * `GET /field-api-lookup-providers`. Note the absence of `authConfig`/`authConfigEnc`: a
 * credential never crosses this boundary in either direction on a read. `authType` *is* present —
 * knowing that a provider needs a bearer token is not itself a secret, and the UI needs it to
 * explain why a `planned` provider is not usable yet.
 */
export const fieldApiLookupProviderSchema = z
  .object({
    id: z.number().int(),
    providerCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    endpointUrl: z.string(),
    httpMethod: z.string(),
    authType: z.string(),
    responseValueKey: z.string(),
    responseLabelKey: z.string(),
    status: z.string(),
  })
  .strict();

export type FieldApiLookupProvider = z.infer<typeof fieldApiLookupProviderSchema>;

export const fieldApiLookupProviderEnvelopeSchema = z
  .object({ data: fieldApiLookupProviderSchema })
  .strict();

export const fieldApiLookupProviderListEnvelopeSchema = z
  .object({ data: z.array(fieldApiLookupProviderSchema) })
  .strict();

/** `POST /field-context-providers` — Super Admin only. `status` is always `active` on create. */
export const createFieldContextProviderRequestSchema = z
  .object({
    providerCode: providerCodeSchema,
    name: z.string().min(1).max(NAME_MAX),
    description: z.string().max(DESCRIPTION_MAX).optional(),
  })
  .strict();

export type CreateFieldContextProviderRequest = z.infer<
  typeof createFieldContextProviderRequestSchema
>;

/** `PATCH /field-context-providers/:id` — `providerCode` is immutable, never accepted here. */
export const updateFieldContextProviderRequestSchema = z
  .object({
    name: z.string().min(1).max(NAME_MAX).optional(),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    status: fieldContextProviderStatusSchema.optional(),
  })
  .strict();

export type UpdateFieldContextProviderRequest = z.infer<
  typeof updateFieldContextProviderRequestSchema
>;

/**
 * `POST /field-api-lookup-providers` — Super Admin only.
 *
 * `status` defaults to `planned` rather than `active`: a provider is not usable until someone has
 * confirmed its real endpoint and auth with the team that owns that data, and the safe default for
 * "a caller did not say" is the state that makes T-123 decline rather than attempt a call.
 *
 * `authConfig` is a free-form object (`{ headerName, apiKey }`, `{ token }`, ... — the shape
 * depends on `authType`, none of which is confirmed yet). It is encrypted before it is stored and
 * is never returned by any endpoint.
 */
export const createFieldApiLookupProviderRequestSchema = z
  .object({
    providerCode: providerCodeSchema,
    name: z.string().min(1).max(NAME_MAX),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    endpointUrl: z.string().min(1).max(ENDPOINT_URL_MAX),
    httpMethod: fieldApiLookupHttpMethodSchema.optional(),
    authType: fieldApiLookupAuthTypeSchema.optional(),
    authConfig: z.record(z.unknown()).optional(),
    responseValueKey: z.string().min(1).max(RESPONSE_KEY_MAX),
    responseLabelKey: z.string().min(1).max(RESPONSE_KEY_MAX),
    status: fieldApiLookupProviderStatusSchema.optional(),
  })
  .strict();

export type CreateFieldApiLookupProviderRequest = z.infer<
  typeof createFieldApiLookupProviderRequestSchema
>;

/** `PATCH /field-api-lookup-providers/:id` — `providerCode` is immutable, never accepted here. */
export const updateFieldApiLookupProviderRequestSchema = z
  .object({
    name: z.string().min(1).max(NAME_MAX).optional(),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    endpointUrl: z.string().min(1).max(ENDPOINT_URL_MAX).optional(),
    httpMethod: fieldApiLookupHttpMethodSchema.optional(),
    authType: fieldApiLookupAuthTypeSchema.optional(),
    authConfig: z.record(z.unknown()).optional(),
    responseValueKey: z.string().min(1).max(RESPONSE_KEY_MAX).optional(),
    responseLabelKey: z.string().min(1).max(RESPONSE_KEY_MAX).optional(),
    status: fieldApiLookupProviderStatusSchema.optional(),
  })
  .strict();

export type UpdateFieldApiLookupProviderRequest = z.infer<
  typeof updateFieldApiLookupProviderRequestSchema
>;
