/**
 * T-045 — assembles one `GET /audit/trace/:correlationId` response (08-OBSERVABILITY.md §6).
 *
 * ### Why there is no tenancy scope anywhere in this file
 *
 * Every other Wave 3 service reads through `ScopedRepository` *because* the actor's tenant/
 * country/merchant constrains which rows they may see. This endpoint has no such constraint —
 * implementation note 1 and 08-OBSERVABILITY.md §6 are explicit that it is **`super_admin`
 * only**, precisely *because* "a trace aggregates data across tenants by nature" and cannot be
 * safely scoped to a lower role. `ScopedRepository` is still used for both DB-backed sources
 * (AGENT-PROTOCOL R2 — it is the only sanctioned path to a `reward_config`/`reward_portal`
 * table), but for `super_admin` its own scope compiler (`scope-strategy.ts`,
 * `buildScopeWhere`) adds no predicate at all: *"Global by design... this is the *only* role
 * that skips the map."* Do not "fix" this into a scoped read for another role — there is no
 * scope that would make a cross-tenant assembly meaningful, and 02-SECURITY.md's tenancy model
 * has no notion of "your own trace".
 *
 * ### The "not found" rule
 *
 * A correlation id is reported 404 only when **every source this service can actually verify**
 * came back empty: `portal_audit_log`, `campaign_audit_trail`, and the log store *if it answered
 * at all*. A degraded log store cannot be used to prove absence — see `assemble`'s own comment —
 * so an outage never manufactures a false "this trace never existed".
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationFailedError } from '@/common/errors/app-error';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { CampaignAuditTrail } from '@/database/models';
import { PortalAuditLog } from '@/database/portal-models';
import type { TraceResponse, TraceSourceStatus, TraceSources } from '@reward-portal/shared';
import { CONFIG_FETCH_ADAPTER, type ConfigFetchAdapter } from './adapters/config-fetch.adapter';
import { LOG_STORE_ADAPTER, type LogStoreAdapter } from './adapters/log-store.adapter';
import { buildTraceResponse } from './dto/trace-response.dto';
import { domainAuditCorrelationWhere } from './domain-audit-query';
import { deriveTimeline, RowBudget, type RawLogLine } from './trace-assembly';
import { TRACE_CORRELATION_ID_PATTERN } from './trace.constants';
import {
  DEFAULT_TRACE_SOURCE_CONFIG,
  TRACE_SOURCE_CONFIG,
  type TraceSourceConfig,
} from './trace-source-config';

@Injectable()
export class TraceService {
  constructor(
    private readonly scoped: ScopedRepository,
    @Inject(LOG_STORE_ADAPTER) private readonly logStore: LogStoreAdapter,
    @Inject(CONFIG_FETCH_ADAPTER) private readonly configFetch: ConfigFetchAdapter,
    @Inject(TRACE_SOURCE_CONFIG)
    private readonly sourceConfig: TraceSourceConfig = DEFAULT_TRACE_SOURCE_CONFIG,
  ) {}

  /**
   * The whole assembly. Never throws for a source being down — only for a malformed id (400,
   * TC-7/TC-8, checked before any query runs) or a genuinely unknown one (404, TC-6).
   */
  async assemble(correlationId: string): Promise<TraceResponse> {
    // Implementation note 4 / TC-7 / TC-8: validated **before** it reaches any query or log
    // line, character-for-character the same pattern `CorrelationMiddleware` itself enforces.
    if (!TRACE_CORRELATION_ID_PATTERN.test(correlationId)) {
      throw new ValidationFailedError([{ field: 'correlationId', code: 'INVALID_FORMAT' }]);
    }

    const budget = new RowBudget();

    const portalRows = await this.fetchPortalAuditRows(correlationId, budget);
    const domainRows = await this.fetchDomainAuditRows(correlationId, budget);
    const logResult = await this.fetchLogLines(correlationId, budget);
    const configResult = await this.fetchConfigFetches(correlationId, budget);

    const { summary, spans } = deriveTimeline(correlationId, logResult.lines);

    if (isUnknown(portalRows.length, domainRows.length, logResult)) {
      throw new NotFoundError();
    }

    const sources: TraceSources = {
      portalAuditLog: 'available',
      domainAudit: 'available',
      logStore: logResult.status,
      configFetches: configResult.status,
    };

    return buildTraceResponse({
      correlationId,
      summary,
      spans,
      sources,
      portalRows,
      domainRows,
      logLines: logResult.lines,
      configFetches: configResult.entries ?? [],
      truncated: budget.truncated(),
    });
  }

  private async fetchPortalAuditRows(
    correlationId: string,
    budget: RowBudget,
  ): Promise<readonly PortalAuditLog[]> {
    const rows = await this.scoped.listAll(PortalAuditLog, {
      where: { correlationId },
      order: [['occurredAt', 'ASC']],
      limit: budget.fetchLimit(),
    });
    return budget.take(rows);
  }

  private async fetchDomainAuditRows(
    correlationId: string,
    budget: RowBudget,
  ): Promise<readonly CampaignAuditTrail[]> {
    const { where, replacements } = domainAuditCorrelationWhere(correlationId);
    const rows = await this.scoped.listAll(CampaignAuditTrail, {
      where,
      replacements,
      order: [['performedAt', 'ASC']],
      limit: budget.fetchLimit(),
    });
    return budget.take(rows);
  }

  private async fetchLogLines(
    correlationId: string,
    budget: RowBudget,
  ): Promise<{ status: TraceSourceStatus; lines: readonly RawLogLine[] | null }> {
    if (!this.sourceConfig.logStoreConfigured) {
      return { status: 'not_configured', lines: null };
    }

    const lines = await this.logStore.fetchLines(correlationId, budget.fetchLimit());
    if (lines === null) return { status: 'unavailable', lines: null };
    return { status: 'available', lines: budget.take(lines) };
  }

  private async fetchConfigFetches(
    correlationId: string,
    budget: RowBudget,
  ): Promise<{ status: TraceSourceStatus; entries: readonly Record<string, unknown>[] | null }> {
    if (!this.sourceConfig.configFetchConfigured) {
      return { status: 'not_configured', entries: null };
    }

    const entries = await this.configFetch.fetchEntries(correlationId, budget.fetchLimit());
    if (entries === null) return { status: 'unavailable', entries: null };
    return { status: 'available', entries: budget.take(entries) };
  }
}

/**
 * TC-6. `true` only when every source that could possibly have evidence came back with nothing.
 *
 * `unavailable` (a transient log-store outage) is the one status excluded from this check:
 * `null` there means "could not confirm either way", and treating it as "found nothing" would
 * turn a transient outage into a false 404 for a request that genuinely happened — the exact
 * false negative implementation note 3 exists to prevent. `not_configured` is treated the same
 * as "available and empty" rather than excluded, deliberately: unlike an outage, "no adapter is
 * wired" is a stable fact about this deployment, not a reason to doubt the two DB-backed sources'
 * own answer, and today (no `TRACE_LOG_STORE` set) `portal_audit_log`/`campaign_audit_trail` are
 * the only evidence this endpoint has at all — treating their combined silence as "unknown" is
 * the honest answer, not a false negative. `configFetches` is never authoritative for existence
 * either way (supplementary narrative, not evidence a request occurred — see
 * `adapters/config-fetch.adapter.ts`), so it plays no part in this decision.
 */
function isUnknown(
  portalRowCount: number,
  domainRowCount: number,
  logResult: { status: TraceSourceStatus; lines: readonly RawLogLine[] | null },
): boolean {
  if (portalRowCount > 0 || domainRowCount > 0) return false;
  if (logResult.status === 'unavailable') return false;
  return (logResult.lines ?? []).length === 0;
}
