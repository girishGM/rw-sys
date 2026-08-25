/**
 * T-045 — `TraceService.assemble`, against in-memory doubles for `ScopedRepository` and the two
 * pluggable adapters. `trace.e2e-spec.ts` proves the same test cases against the real database and
 * a real HTTP round trip; this suite proves the *decisions* (which query, which status, which
 * response shape) fast and without a live Postgres.
 */
import { NotFoundError, ValidationFailedError } from '@/common/errors/app-error';
import { CampaignAuditTrail } from '@/database/models';
import { PortalAuditLog } from '@/database/portal-models';
import { TraceService } from '@/modules/trace/trace.service';
import { MAX_TRACE_ROWS } from '@/modules/trace/trace.constants';
import type { TraceSourceConfig } from '@/modules/trace/trace-source-config';
import {
  asScopedRepository,
  FakeConfigFetchAdapter,
  FakeLogStoreAdapter,
  FakeScopedRepository,
} from './support/trace-doubles';

const CID = '01J8F3K9QP2M7N';

function makeService(
  overrides: {
    scoped?: FakeScopedRepository;
    logStore?: FakeLogStoreAdapter;
    configFetch?: FakeConfigFetchAdapter;
    sourceConfig?: TraceSourceConfig;
  } = {},
) {
  const scoped = overrides.scoped ?? new FakeScopedRepository();
  const logStore = overrides.logStore ?? new FakeLogStoreAdapter();
  const configFetch = overrides.configFetch ?? new FakeConfigFetchAdapter();
  const sourceConfig = overrides.sourceConfig ?? {
    logStoreConfigured: false,
    configFetchConfigured: false,
  };

  const service = new TraceService(asScopedRepository(scoped), logStore, configFetch, sourceConfig);
  return { service, scoped, logStore, configFetch };
}

const portalRow = {
  id: '101',
  eventType: 'login_succeeded',
  actorId: 42,
  actorRole: 'maker',
  targetType: null,
  targetId: null,
  countryId: 3,
  tenantId: 7,
  ipAddress: '10.0.0.4',
  detail: { note: 'ok' },
  occurredAt: new Date('2026-08-14T09:12:33.000Z'),
};

const domainRow = {
  id: 202,
  tenantId: 7,
  campaignId: 8821,
  entityType: 'campaign_submit',
  entityId: null,
  action: 'submitted',
  fieldChanges: { __correlationId: CID },
  performedBy: 42,
  performedAt: new Date('2026-08-14T09:12:33.100Z'),
  approvalRequestId: 55,
  comment: null,
};

const completionLine = {
  ts: '2026-08-14T09:12:33.481Z',
  msg: 'request completed',
  correlationId: CID,
  actor: { userId: 42, role: 'maker', sessionId: 'sess-1' },
  scope: { countryId: 3, tenantId: 7, merchantId: null },
  http: {
    method: 'POST',
    route: 'POST /api/v1/campaigns/:id/submit',
    status: 200,
    durationMs: 142,
  },
  spans: [{ name: 'jwt.verify', startedAtMs: 0.2, durationMs: 0.8, status: 'ok', spanId: 'a1' }],
};

describe('TC-7/TC-8 — malformed correlation id', () => {
  it.each(['short', '../etc/passwd', 'has a space', 'has\nnewline12', ''])(
    'rejects %j with 400 before any query runs',
    async (bad) => {
      const { service, scoped, logStore } = makeService();
      await expect(service.assemble(bad)).rejects.toBeInstanceOf(ValidationFailedError);
      expect(scoped.calls).toHaveLength(0);
      expect(logStore.lastRequestedLimit).toBeNull();
    },
  );
});

describe('TC-6 — unknown correlation id', () => {
  it('is 404 when every checkable source is empty', async () => {
    const { service } = makeService();
    await expect(service.assemble(CID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is 404 with the log store configured and reachable but empty', async () => {
    const logStore = new FakeLogStoreAdapter();
    logStore.lines = [];
    const { service } = makeService({
      logStore,
      sourceConfig: { logStoreConfigured: true, configFetchConfigured: false },
    });
    await expect(service.assemble(CID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('TC-1 — a completed request', () => {
  it('assembles all available sources, correlated', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setRows(PortalAuditLog, [portalRow]);
    scoped.setRows(CampaignAuditTrail, [domainRow]);
    const logStore = new FakeLogStoreAdapter();
    logStore.lines = [completionLine];

    const { service } = makeService({
      scoped,
      logStore,
      sourceConfig: { logStoreConfigured: true, configFetchConfigured: false },
    });

    const response = await service.assemble(CID);

    expect(response.correlationId).toBe(CID);
    expect(response.sources).toEqual({
      portalAuditLog: 'available',
      domainAudit: 'available',
      logStore: 'available',
      configFetches: 'not_configured',
    });
    expect(response.auditEvents).toHaveLength(1);
    expect(response.auditEvents[0].id).toBe('101');
    expect(response.domainAudit).toHaveLength(1);
    expect(response.domainAudit[0].campaignId).toBe(8821);
    expect(response.summary.status).toBe(200);
    expect(response.spans).toHaveLength(1);
    expect(response.truncated).toBe(false);
  });
});

describe('TC-3 — a campaign submit', () => {
  it('surfaces the domain audit row and its approval request id', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setRows(CampaignAuditTrail, [domainRow]);
    const { service } = makeService({ scoped });

    const response = await service.assemble(CID);
    expect(response.domainAudit[0].approvalRequestId).toBe(55);
    expect(response.domainAudit[0].action).toBe('submitted');
  });
});

describe('TC-5 — log store unreachable', () => {
  it('is 200 with logLines: null, and sources reports it, when other sources have data', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setRows(PortalAuditLog, [portalRow]);
    const logStore = new FakeLogStoreAdapter();
    logStore.lines = null; // unreachable

    const { service } = makeService({
      scoped,
      logStore,
      sourceConfig: { logStoreConfigured: true, configFetchConfigured: false },
    });

    const response = await service.assemble(CID);
    expect(response.logLines).toBeNull();
    expect(response.sources.logStore).toBe('unavailable');
    // Not a 404 — the log store being down never manufactures a false negative.
    expect(response.auditEvents).toHaveLength(1);
  });

  it('does not report 404 purely because the log store is down and DB sources are also empty', async () => {
    const logStore = new FakeLogStoreAdapter();
    logStore.lines = null;
    const { service } = makeService({
      logStore,
      sourceConfig: { logStoreConfigured: true, configFetchConfigured: false },
    });

    // Cannot confirm absence while a source is down — this must NOT throw NotFoundError.
    const response = await service.assemble(CID);
    expect(response.sources.logStore).toBe('unavailable');
  });
});

describe('configFetches — not wired (T-047 seam)', () => {
  it('reports not_configured by default, and an empty array rather than null in the body', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setRows(PortalAuditLog, [portalRow]);
    const { service } = makeService({ scoped });

    const response = await service.assemble(CID);
    expect(response.sources.configFetches).toBe('not_configured');
    expect(response.configFetches).toEqual([]);
  });

  it('once configured, surfaces entries and reports available (forward-compatible with T-047)', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setRows(PortalAuditLog, [portalRow]);
    const configFetch = new FakeConfigFetchAdapter();
    configFetch.entries = [{ service: 'campaign-runtime', tenantId: 7 }];

    const { service } = makeService({
      scoped,
      configFetch,
      sourceConfig: { logStoreConfigured: false, configFetchConfigured: true },
    });

    const response = await service.assemble(CID);
    expect(response.sources.configFetches).toBe('available');
    expect(response.configFetches).toEqual([{ service: 'campaign-runtime', tenantId: 7 }]);
  });

  it('reports unavailable when configured but the adapter cannot answer', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setRows(PortalAuditLog, [portalRow]);
    const configFetch = new FakeConfigFetchAdapter();
    configFetch.entries = null;

    const { service } = makeService({
      scoped,
      configFetch,
      sourceConfig: { logStoreConfigured: false, configFetchConfigured: true },
    });

    const response = await service.assemble(CID);
    expect(response.sources.configFetches).toBe('unavailable');
    expect(response.configFetches).toEqual([]);
  });
});

describe('TC-19 — no domain audit rows', () => {
  it('renders an empty domainAudit array rather than omitting the key', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setRows(PortalAuditLog, [portalRow]);
    const { service } = makeService({ scoped });

    const response = await service.assemble(CID);
    expect(response.domainAudit).toEqual([]);
  });
});

describe('TC-14 — more than 5,000 rows across sources', () => {
  it('truncates rather than assembling everything, and never times out (bounded work)', async () => {
    const bigPortal = Array.from({ length: 4000 }, (_, i) => ({ ...portalRow, id: String(i) }));
    const bigDomain = Array.from({ length: 2000 }, (_, i) => ({ ...domainRow, id: i }));
    const scoped = new FakeScopedRepository();
    scoped.setRows(PortalAuditLog, bigPortal);
    scoped.setRows(CampaignAuditTrail, bigDomain);

    const { service } = makeService({ scoped });
    const response = await service.assemble(CID);

    expect(response.truncated).toBe(true);
    expect(response.auditEvents.length + response.domainAudit.length).toBeLessThanOrEqual(
      MAX_TRACE_ROWS,
    );
    expect(response.auditEvents).toHaveLength(4000);
    expect(response.domainAudit).toHaveLength(1000);
  });
});

describe('query shape', () => {
  it('queries portal_audit_log by the exact correlation id column', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setRows(PortalAuditLog, [portalRow]);
    const { service } = makeService({ scoped });

    await service.assemble(CID);

    const call = scoped.callsTo('PortalAuditLog')[0];
    expect(call.options.where).toEqual({ correlationId: CID });
  });

  it('queries campaign_audit_trail with a bound LIKE clause, never string-interpolated', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setRows(CampaignAuditTrail, [domainRow]);
    const { service } = makeService({ scoped });

    await service.assemble(CID);

    const call = scoped.callsTo('CampaignAuditTrail')[0];
    // The id lives only in the bound replacement value — never in the WHERE clause's own SQL text.
    expect(JSON.stringify(call.options.where)).not.toContain(CID);
    expect((call.options as { replacements?: Record<string, string> }).replacements).toEqual({
      domainCorrelationPattern: expect.stringContaining(CID) as unknown as string,
    });
  });
});
