/**
 * T-045 — the wire contract of `GET /audit/trace/:correlationId` (08-OBSERVABILITY.md §6),
 * shared by the back end that assembles it and the trace-viewer SPA that renders it
 * (00-ARCHITECTURE.md §8: "One Zod schema shared with the back end via `packages/shared`").
 *
 * ### What this file is for
 *
 * The endpoint's whole job is to turn one `correlationId` into "the complete story of a
 * request" (08-OBSERVABILITY.md §6's intro), assembled from up to four independent stores that
 * can each be present, empty, or unreachable. Declaring the shape once — here — is what lets
 * the front end trust that "a source is degraded" and "a source has no rows" are two different,
 * always-present states rather than something inferred from an absent key.
 *
 * ### Why every object is `.strict()`
 *
 * Same reasoning as `bootstrap.schema.ts`: a `.strict()` object rejects an unrecognised key
 * instead of silently stripping it, so a field this endpoint should never carry — a raw
 * password hash surfacing inside a `detail` blob, say — fails the contract test that runs this
 * schema against a real response, rather than shipping unnoticed. T-017's masking is what keeps
 * that from happening in practice; this schema is what proves it.
 *
 * ### What this file must not become
 *
 * A place for behaviour. It describes bytes on a wire — no defaults, no coercion, no transforms.
 */
import { z } from 'zod';

/**
 * 08-OBSERVABILITY.md §1, verbatim — the same pattern the back end's own
 * `common/errors/trace-id.ts` validates a correlation id against before it reaches any query or
 * log line. Duplicated rather than imported: the front end cannot import from `back-end/src`,
 * and `back-end/test/trace/correlation-id-pattern.spec.ts` asserts the two stay identical.
 */
export const TRACE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Whether one of the trace's four stores answered, was empty, or could not be reached. */
export const traceSourceStatusSchema = z.enum([
  /** The store was queried and (possibly empty) results were returned. */
  'available',
  /** The store is wired but did not answer in time / is down right now. */
  'unavailable',
  /** No adapter is configured for this store yet (08-OBSERVABILITY.md §9's T-047 seam). */
  'not_configured',
]);

export type TraceSourceStatus = z.infer<typeof traceSourceStatusSchema>;

/** Which of the four sources 08-OBSERVABILITY.md §6 lists contributed to this assembly. */
export const traceSourcesSchema = z
  .object({
    portalAuditLog: traceSourceStatusSchema,
    domainAudit: traceSourceStatusSchema,
    logStore: traceSourceStatusSchema,
    configFetches: traceSourceStatusSchema,
  })
  .strict();

export type TraceSources = z.infer<typeof traceSourcesSchema>;

/** §5's three span outcomes. `denied` is the chain refusing, not failing — see `span.service.ts`. */
export const traceSpanStatusSchema = z.enum(['ok', 'error', 'denied']);

/** One row of the §5 waterfall, as reconstructed from the request's own completion log line. */
export const traceSpanSchema = z
  .object({
    name: z.string(),
    startedAtMs: z.number(),
    durationMs: z.number(),
    status: traceSpanStatusSchema,
    spanId: z.string(),
    /** Implementation note 6: `durationMs` is more than 25% of the request's total duration. */
    slow: z.boolean(),
    attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
  })
  .strict();

export type TraceSpan = z.infer<typeof traceSpanSchema>;

const traceActorSchema = z
  .object({
    userId: z.number().int().nullable(),
    role: z.string().nullable(),
    sessionId: z.string().nullable(),
  })
  .strict();

const traceScopeSchema = z
  .object({
    countryId: z.number().int().nullable(),
    tenantId: z.number().int().nullable(),
    merchantId: z.number().int().nullable(),
  })
  .strict();

/**
 * The one-line summary of the request the correlation id names — §6's `summary` block.
 *
 * Every field is nullable: the summary is reconstructed from a "request completed" log line, and
 * when the log store is unavailable (or has not yet received the line) there is nothing to
 * reconstruct it from. `correlationId` is the one exception — it is always the id the caller
 * asked for, never derived.
 */
export const traceSummarySchema = z
  .object({
    correlationId: z.string(),
    startedAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    actor: traceActorSchema.nullable(),
    scope: traceScopeSchema.nullable(),
    route: z.string().nullable(),
    status: z.number().int().nullable(),
  })
  .strict();

export type TraceSummary = z.infer<typeof traceSummarySchema>;

/** One `reward_portal.portal_audit_log` row (07-DATA-PROTECTION.md masking already applied). */
export const traceAuditEventSchema = z
  .object({
    id: z.string(),
    eventType: z.string(),
    actorId: z.number().int().nullable(),
    actorRole: z.string().nullable(),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    countryId: z.number().int().nullable(),
    tenantId: z.number().int().nullable(),
    ipAddress: z.string().nullable(),
    detail: z.record(z.unknown()).nullable(),
    occurredAt: z.string(),
  })
  .strict();

export type TraceAuditEvent = z.infer<typeof traceAuditEventSchema>;

/** One `reward_config.campaign_audit_trail` row — the cross-link target for #7's "back to the
 * campaign, the rule version and the approval request". */
export const traceDomainAuditEventSchema = z
  .object({
    id: z.number().int(),
    tenantId: z.number().int(),
    campaignId: z.number().int(),
    entityType: z.string(),
    entityId: z.number().int().nullable(),
    action: z.string(),
    fieldChanges: z.record(z.unknown()).nullable(),
    performedBy: z.number().int(),
    performedAt: z.string(),
    approvalRequestId: z.number().int().nullable(),
    comment: z.string().nullable(),
  })
  .strict();

export type TraceDomainAuditEvent = z.infer<typeof traceDomainAuditEventSchema>;

/**
 * One gRPC config-fetch access-log entry (08-OBSERVABILITY.md §6's `configFetches`).
 *
 * Free-form pending T-047, which owns the `grpc_service_grants` access log this source reads
 * from — see `adapters/config-fetch.adapter.ts`. The array is always empty today; the shape is
 * declared now so the front end does not need a breaking change when T-047 wires it.
 */
export const traceConfigFetchSchema = z.record(z.unknown());

/** The full `GET /audit/trace/:correlationId` payload — 08-OBSERVABILITY.md §6. */
export const traceResponseSchema = z
  .object({
    correlationId: z.string(),
    summary: traceSummarySchema,
    spans: z.array(traceSpanSchema),
    sources: traceSourcesSchema,
    auditEvents: z.array(traceAuditEventSchema),
    domainAudit: z.array(traceDomainAuditEventSchema),
    configFetches: z.array(traceConfigFetchSchema),
    /** Raw log-store lines, masked. `null` exactly when `sources.logStore !== 'available'`. */
    logLines: z.array(z.record(z.unknown())).nullable(),
    /** Implementation note 8 — the 5,000-row cap across sources was hit. */
    truncated: z.boolean(),
  })
  .strict();

export type TraceResponse = z.infer<typeof traceResponseSchema>;

export const traceEnvelopeSchema = z.object({ data: traceResponseSchema }).strict();
