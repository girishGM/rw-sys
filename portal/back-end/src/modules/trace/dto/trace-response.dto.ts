/**
 * T-045 — shaping the four sources into 08-OBSERVABILITY.md §6's wire response.
 *
 * Every mapper below builds a **plain object** with an explicit, closed set of keys — never the
 * Sequelize instance itself. Two reasons, not one:
 *
 *  - `PortalAuditLog`/`CampaignAuditTrail` carry no `data_protection_policies` rows of their own
 *    yet (verified against `T017_002_seed_policies.ts` — flagged in the completion report), so
 *    `ResponseMaskingInterceptor`'s container-aware fail-closed ladder has nothing to apply to
 *    either table today; an explicit shape costs nothing this endpoint would otherwise have.
 *  - A raw Sequelize instance's *own* enumerable properties are its internal bookkeeping
 *    (`dataValues`, `_previousDataValues`, `_changed`, `_options`, …) — attributes are accessed
 *    through prototype getters, which a plain object-walk (`Object.entries`) does not traverse.
 *    Handing the interceptor the instance itself risks the walk copying that internal state into
 *    the response rather than the columns it looks like it would; an explicit mapper cannot make
 *    that mistake because it never reads anything but the named getters.
 *
 * Every field named here is still walked by `ResponseMaskingInterceptor` by bare name afterwards
 * (implementation note 5) — `detail`/`fieldChanges` in particular are handed through untouched so
 * the interceptor's recursive alias matching (`policy.service.ts`'s `byAlias`) still reaches
 * whatever PII they contain by key name, exactly as it would for any other DTO in this codebase.
 */
import type { PortalAuditLog } from '@/database/portal-models';
import type { CampaignAuditTrail } from '@/database/models';
import type {
  TraceAuditEvent,
  TraceDomainAuditEvent,
  TraceResponse,
  TraceSources,
} from '@reward-portal/shared';
import type { DerivedSpan, DerivedSummary, RawLogLine } from '../trace-assembly';

export function portalAuditEventOf(row: PortalAuditLog): TraceAuditEvent {
  return {
    id: String(row.id),
    eventType: row.eventType,
    actorId: row.actorId,
    actorRole: row.actorRole,
    targetType: row.targetType,
    targetId: row.targetId,
    countryId: row.countryId,
    tenantId: row.tenantId,
    ipAddress: row.ipAddress,
    detail: row.detail,
    occurredAt: row.occurredAt.toISOString(),
  };
}

export function domainAuditEventOf(row: CampaignAuditTrail): TraceDomainAuditEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    campaignId: row.campaignId,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    // `fieldChanges` still carries T-019's `__correlationId` envelope key (audit.repository.ts) —
    // left in rather than stripped, so the trace view can show precisely what
    // `serialiseFieldChanges` wrote, the same way an audit viewer reading this table directly
    // would see it.
    fieldChanges: row.fieldChanges,
    performedBy: row.performedBy,
    performedAt: row.performedAt.toISOString(),
    approvalRequestId: row.approvalRequestId,
    comment: row.comment,
  };
}

export interface BuildTraceResponseInput {
  readonly correlationId: string;
  readonly summary: DerivedSummary;
  readonly spans: readonly DerivedSpan[];
  readonly sources: TraceSources;
  readonly portalRows: readonly PortalAuditLog[];
  readonly domainRows: readonly CampaignAuditTrail[];
  readonly logLines: readonly RawLogLine[] | null;
  readonly configFetches: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

export function buildTraceResponse(input: BuildTraceResponseInput): TraceResponse {
  return {
    correlationId: input.correlationId,
    summary: input.summary,
    spans: input.spans as TraceResponse['spans'],
    sources: input.sources,
    auditEvents: input.portalRows.map(portalAuditEventOf),
    domainAudit: input.domainRows.map(domainAuditEventOf),
    configFetches: input.configFetches as TraceResponse['configFetches'],
    logLines: input.logLines as TraceResponse['logLines'],
    truncated: input.truncated,
  };
}

/** The `{ data }` envelope, 03-API-CONTRACT.md §1. */
export function traceEnvelope(response: TraceResponse): { data: TraceResponse } {
  return { data: response };
}
