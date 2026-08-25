/**
 * T-040 — `AuditViewerService`, against an in-memory `ScopedRepository` double.
 * `audit-viewer.e2e-spec.ts` proves the same properties against the real database and the real,
 * already-shipped scope strategy (T-013).
 */
import { AUDIT_MAX_PAGE_SIZE, AUDIT_CSV_ROW_CAP } from '@/modules/audit/audit.constants';
import { AuditViewerService } from '@/modules/audit/audit-viewer.service';
import { asScopedRepository, FakeScopedRepository } from './support/audit-viewer-doubles';

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    tenantId: 9,
    campaignId: 55,
    entityType: 'campaign_submit',
    entityId: null,
    action: 'submitted',
    fieldChanges: {},
    performedBy: 42,
    performedAt: new Date('2026-08-19T00:00:00.000Z'),
    approvedBy: null,
    approvedAt: null,
    approvalRequestId: null,
    comment: null,
    ...overrides,
  };
}

function portalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    eventType: 'login_succeeded',
    actorId: 7,
    actorRole: 'maker',
    targetType: null,
    targetId: null,
    countryId: 3,
    tenantId: 9,
    ipAddress: null,
    detail: {},
    occurredAt: new Date('2026-08-19T00:00:00.000Z'),
    ...overrides,
  };
}

function makeService(rows: Record<string, unknown>[] = []) {
  const scoped = new FakeScopedRepository();
  scoped.rows = rows;
  const service = new AuditViewerService(asScopedRepository(scoped));
  return { service, scoped };
}

describe('TC-15 — audit filters (date, actor, action)', () => {
  it('filters campaign audit rows by actorId and action', async () => {
    const { service } = makeService([
      campaignRow({ id: 1, performedBy: 42, action: 'submitted' }),
      campaignRow({ id: 2, performedBy: 99, action: 'submitted' }),
      campaignRow({ id: 3, performedBy: 42, action: 'approved' }),
    ]);

    const page = await service.listCampaignAudit({ actorId: 42, action: 'submitted' });

    expect(page.items).toEqual([campaignRow({ id: 1, performedBy: 42, action: 'submitted' })]);
  });

  it('filters by a date range', async () => {
    const { service } = makeService([
      campaignRow({ id: 1, performedAt: new Date('2026-01-01T00:00:00Z') }),
      campaignRow({ id: 2, performedAt: new Date('2026-06-01T00:00:00Z') }),
    ]);

    const page = await service.listCampaignAudit({
      dateFrom: '2026-05-01T00:00:00Z',
      dateTo: '2026-07-01T00:00:00Z',
    });

    expect(page.items.map((r) => (r as unknown as { id: number }).id)).toEqual([2]);
  });

  it('filters portal audit rows by eventType and targetType', async () => {
    const { service } = makeService([
      portalRow({ id: '1', eventType: 'login_succeeded' }),
      portalRow({ id: '2', eventType: 'permission_denied' }),
    ]);

    const page = await service.listPortalAudit({ eventType: 'permission_denied' });

    expect(page.items).toEqual([portalRow({ id: '2', eventType: 'permission_denied' })]);
  });

  it('filters portal audit rows by actorId and a date range', async () => {
    const { service } = makeService([
      portalRow({ id: '1', actorId: 7, occurredAt: new Date('2026-01-01T00:00:00Z') }),
      portalRow({ id: '2', actorId: 7, occurredAt: new Date('2026-06-01T00:00:00Z') }),
      portalRow({ id: '3', actorId: 99, occurredAt: new Date('2026-06-01T00:00:00Z') }),
    ]);

    const page = await service.listPortalAudit({
      actorId: 7,
      dateFrom: '2026-05-01T00:00:00Z',
    });

    expect(page.items.map((r) => (r as unknown as { id: string }).id)).toEqual(['2']);
  });
});

describe("TC-14 — tenant A admin filters for tenant B's campaign", () => {
  it("an out-of-scope campaignId yields an empty page, never another tenant's rows", async () => {
    // `ScopedRepository`'s own tenant predicate is what a real request adds (proved in the e2e
    // suite); this double only proves the service *asks* for the campaignId filter it was given.
    const { service } = makeService([campaignRow({ id: 1, campaignId: 55, tenantId: 9 })]);

    const page = await service.listCampaignAudit({ campaignId: 999 });

    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
  });
});

describe('pagination', () => {
  it('caps pageSize at the documented maximum', async () => {
    const { service, scoped } = makeService([campaignRow()]);

    await service.listCampaignAudit({ pageSize: 99_999 });

    const call = scoped.calls.find((c) => c.method === 'listAll');
    expect((call?.options as { limit: number }).limit).toBe(AUDIT_MAX_PAGE_SIZE);
  });

  it('treats an explicit pageSize below 1 the same as no pageSize at all', async () => {
    const { service, scoped } = makeService([campaignRow()]);

    await service.listPortalAudit({ pageSize: 0, page: 0 });

    const call = scoped.calls.find((c) => c.method === 'listAll');
    expect((call?.options as { limit: number }).limit).toBe(20);
    expect((call?.options as { offset: number }).offset).toBe(0);
  });
});

describe('TC-20 — CSV streaming and the 10,000-row cap', () => {
  it('delivers every row when under the cap, unmarked as truncated', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => campaignRow({ id: i + 1 }));
    const { service } = makeService(rows);

    const delivered: unknown[] = [];
    const { truncated } = await service.streamCampaignAudit({}, async (batch) => {
      delivered.push(...batch);
    });

    expect(truncated).toBe(false);
    expect(delivered).toHaveLength(5);
  });

  it('caps at 10,000 rows and reports truncation when more exist', async () => {
    const rows = Array.from({ length: AUDIT_CSV_ROW_CAP + 25 }, (_, i) =>
      campaignRow({ id: i + 1 }),
    );
    const { service } = makeService(rows);

    const delivered: unknown[] = [];
    const { truncated } = await service.streamCampaignAudit({}, async (batch) => {
      delivered.push(...batch);
    });

    expect(truncated).toBe(true);
    expect(delivered).toHaveLength(AUDIT_CSV_ROW_CAP);
  });

  it('reports truncated when the result lands exactly on the cap boundary — conservative by design: with no cheap way to prove no 10,001st row exists, this method never claims completeness it cannot back up', async () => {
    const rows = Array.from({ length: AUDIT_CSV_ROW_CAP }, (_, i) => campaignRow({ id: i + 1 }));
    const { service } = makeService(rows);

    const delivered: unknown[] = [];
    const { truncated } = await service.streamCampaignAudit({}, async (batch) => {
      delivered.push(...batch);
    });

    expect(truncated).toBe(true);
    expect(delivered).toHaveLength(AUDIT_CSV_ROW_CAP);
  });

  it('streams portal audit rows in the same shape', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => portalRow({ id: String(i + 1) }));
    const { service } = makeService(rows);

    const delivered: unknown[] = [];
    const { truncated } = await service.streamPortalAudit({}, async (batch) => {
      delivered.push(...batch);
    });

    expect(truncated).toBe(false);
    expect(delivered).toHaveLength(3);
  });
});
