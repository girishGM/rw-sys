/**
 * T-042 — the wire contract of `/definition-requests` (06-VERSIONING.md §9, "the request
 * workflow — 'can I have a new rule?'"), shared by the back end that produces it and the SPA
 * that consumes it (00-ARCHITECTURE.md §8).
 *
 * `.strict()` everywhere, same discipline `version.schema.ts`/`rule.schema.ts` state in full —
 * no defaults the server never sent, no coercion, an unexpected key fails the contract test
 * rather than shipping silently.
 *
 * `requestingCountryId`/`requestingTenantId` never appear on a *request* schema — only on the
 * response. AGENT-PROTOCOL R3: those two values come from the actor's own JWT scope on the
 * server, never from a client-supplied body field (implementation note 1, TC-2).
 */
import { z } from 'zod';

// ─────────────────────────────── shared primitives ───────────────────────────────────────────

/** `definition_requests.request_type` — `ck_dr_type`. */
export const DEFINITION_REQUEST_TYPES = [
  'new_rule',
  'update_rule',
  'new_reward',
  'update_reward',
] as const;
export const definitionRequestTypeSchema = z.enum(DEFINITION_REQUEST_TYPES);
export type DefinitionRequestType = z.infer<typeof definitionRequestTypeSchema>;

/** `definition_requests.status` — `ck_dr_status` (06-VERSIONING.md §9's state diagram). */
export const DEFINITION_REQUEST_STATUSES = [
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'fulfilled',
  'withdrawn',
] as const;
export const definitionRequestStatusSchema = z.enum(DEFINITION_REQUEST_STATUSES);
export type DefinitionRequestStatus = z.infer<typeof definitionRequestStatusSchema>;

/** `definition_requests.priority` — `ck_dr_priority`. */
export const DEFINITION_REQUEST_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const definitionRequestPrioritySchema = z.enum(DEFINITION_REQUEST_PRIORITIES);
export type DefinitionRequestPriority = z.infer<typeof definitionRequestPrioritySchema>;

/** The subset of {@link DEFINITION_REQUEST_STATUSES} `POST .../review` may move a request to —
 * `submitted` and `withdrawn`/`fulfilled` are reached by other endpoints, never this one. */
export const DEFINITION_REQUEST_REVIEW_TARGET_STATUSES = [
  'under_review',
  'approved',
  'rejected',
] as const;
export const definitionRequestReviewTargetStatusSchema = z.enum(
  DEFINITION_REQUEST_REVIEW_TARGET_STATUSES,
);

export const listMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .strict();

// ────────────────────────────────────── entity ───────────────────────────────────────────────

export const definitionRequestSchema = z
  .object({
    id: z.number().int(),
    requestType: definitionRequestTypeSchema,
    entityId: z.number().int().nullable(),
    requestedBy: z.number().int(),
    requestingCountryId: z.number().int().nullable(),
    requestingTenantId: z.number().int().nullable(),
    title: z.string(),
    description: z.string(),
    businessJustification: z.string().nullable(),
    desiredBy: z.string().nullable(),
    priority: definitionRequestPrioritySchema,
    status: definitionRequestStatusSchema,
    reviewedBy: z.number().int().nullable(),
    reviewedAt: z.string().nullable(),
    reviewComment: z.string().nullable(),
    fulfilledVersionId: z.number().int().nullable(),
    fulfilledAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type DefinitionRequest = z.infer<typeof definitionRequestSchema>;

export const definitionRequestEnvelopeSchema = z.object({ data: definitionRequestSchema }).strict();
export const definitionRequestListEnvelopeSchema = z
  .object({ data: z.array(definitionRequestSchema), meta: listMetaSchema })
  .strict();

// ─────────────────────────────────────── requests ────────────────────────────────────────────

/** `POST /definition-requests` — `country_admin`/`tenant_admin` only (implementation note 1). */
export const createDefinitionRequestSchema = z
  .object({
    requestType: definitionRequestTypeSchema,
    /** Required for `update_rule`/`update_reward`; must be absent for `new_rule`/`new_reward`
     * — enforced server-side, not by the shape alone (implementation note in the service). */
    entityId: z.number().int().optional(),
    title: z.string().min(3).max(200),
    description: z.string().min(10),
    businessJustification: z.string().max(2000).optional(),
    /** `YYYY-MM-DD` — `definition_requests.desired_by` is `date`, not `timestamptz`. */
    desiredBy: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    priority: definitionRequestPrioritySchema.optional(),
  })
  .strict();

export type CreateDefinitionRequestRequest = z.infer<typeof createDefinitionRequestSchema>;

/** `PATCH /definition-requests/:id` — requester, `submitted` only (TC-6/TC-7). */
export const updateDefinitionRequestSchema = z
  .object({
    title: z.string().min(3).max(200).optional(),
    description: z.string().min(10).optional(),
    businessJustification: z.string().max(2000).nullable().optional(),
    desiredBy: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    priority: definitionRequestPrioritySchema.optional(),
  })
  .strict();

export type UpdateDefinitionRequestRequest = z.infer<typeof updateDefinitionRequestSchema>;

/** `POST /definition-requests/:id/review` — `super_admin` only. `reviewComment` is required
 * when `status: 'rejected'` (implementation note 3, TC-10/TC-11) — enforced server-side. */
export const reviewDefinitionRequestSchema = z
  .object({
    status: definitionRequestReviewTargetStatusSchema,
    reviewComment: z.string().max(1000).optional(),
  })
  .strict();

export type ReviewDefinitionRequestRequest = z.infer<typeof reviewDefinitionRequestSchema>;

/** `POST /definition-requests/:id/fulfil` — `super_admin` only. Links a **published** version
 * (implementation note 5, TC-13/TC-14). */
export const fulfilDefinitionRequestSchema = z
  .object({
    versionId: z.number().int(),
  })
  .strict();

export type FulfilDefinitionRequestRequest = z.infer<typeof fulfilDefinitionRequestSchema>;
