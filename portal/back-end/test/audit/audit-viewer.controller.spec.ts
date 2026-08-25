/**
 * T-040 — `AuditViewerController`, against a mocked `AuditViewerService`. Guard behaviour
 * (`@RequirePermission`, `@Roles('super_admin')`) is proved for real in
 * `audit-viewer.e2e-spec.ts`; this suite proves the controller's own shaping — the envelope, the
 * CSV headers/streaming/truncation-notice, and TC-17 (no mutating route exists at all).
 */
import { Response } from 'express';
import { AuditViewerController } from '@/modules/audit/audit-viewer.controller';
import { AUDIT_CSV_ROW_CAP } from '@/modules/audit/audit.constants';
import type { AuditViewerService } from '@/modules/audit/audit-viewer.service';

function fakeResponse() {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const response = {
    setHeader: jest.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    write: jest.fn((chunk: string) => {
      chunks.push(chunk);
    }),
    end: jest.fn(),
  } as unknown as Response;
  return { response, chunks, headers };
}

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    tenantId: 9,
    campaignId: 55,
    entityType: 'campaign_submit',
    entityId: null,
    action: 'submitted',
    fieldChanges: { note: 'ok' },
    performedBy: 42,
    performedAt: new Date('2026-08-19T00:00:00.000Z'),
    approvedBy: null,
    approvedAt: null,
    comment: null,
    ...overrides,
  };
}

describe('GET /audit/campaigns', () => {
  it('envelopes the list with meta', async () => {
    const service = {
      listCampaignAudit: jest
        .fn()
        .mockResolvedValue({ items: [campaignRow()], page: 1, pageSize: 20, total: 1 }),
    } as unknown as AuditViewerService;
    const controller = new AuditViewerController(service);

    const result = await controller.listCampaigns({});

    expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(result.data[0]).toMatchObject({ id: 1, action: 'submitted' });
  });
});

describe('GET /audit/campaigns/export', () => {
  it('sets CSV headers, streams the header row plus every batch, and ends the response', async () => {
    const service = {
      streamCampaignAudit: jest.fn(async (_query, onBatch: (rows: unknown[]) => Promise<void>) => {
        await onBatch([campaignRow({ id: 1 }), campaignRow({ id: 2 })]);
        return { truncated: false };
      }),
    } as unknown as AuditViewerService;
    const controller = new AuditViewerController(service);
    const { response, chunks, headers } = fakeResponse();

    await controller.exportCampaigns({}, response);

    expect(headers['Content-Type']).toContain('text/csv');
    expect(headers['Content-Disposition']).toContain('attachment');
    expect(chunks[0]).toBe(
      'id,tenantId,campaignId,entityType,entityId,action,performedBy,performedAt,approvedBy,approvedAt,comment,fieldChanges\r\n',
    );
    expect(chunks.some((c) => c.startsWith('1,9,55,'))).toBe(true);
    expect(chunks.some((c) => c.startsWith('2,9,55,'))).toBe(true);
    expect(response.end as jest.Mock).toHaveBeenCalled();
  });

  it('TC-20 — appends a clear truncation notice when the export was capped', async () => {
    const service = {
      streamCampaignAudit: jest.fn().mockResolvedValue({ truncated: true }),
    } as unknown as AuditViewerService;
    const controller = new AuditViewerController(service);
    const { response, chunks } = fakeResponse();

    await controller.exportCampaigns({}, response);

    expect(chunks.some((c) => c.includes(`truncated at ${String(AUDIT_CSV_ROW_CAP)} rows`))).toBe(
      true,
    );
  });

  it("TC-19 — a field beginning `=cmd|…` is prefixed with ' in the exported cell", async () => {
    const service = {
      streamCampaignAudit: jest.fn(async (_query, onBatch: (rows: unknown[]) => Promise<void>) => {
        await onBatch([campaignRow({ id: 1, comment: '=cmd|/c calc' })]);
        return { truncated: false };
      }),
    } as unknown as AuditViewerService;
    const controller = new AuditViewerController(service);
    const { response, chunks } = fakeResponse();

    await controller.exportCampaigns({}, response);

    expect(chunks.some((c) => c.includes("'=cmd|/c calc"))).toBe(true);
  });
});

describe('GET /audit/portal', () => {
  it('envelopes the list with meta', async () => {
    const service = {
      listPortalAudit: jest.fn().mockResolvedValue({
        items: [{ id: '1', eventType: 'login_succeeded', occurredAt: new Date() }],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    } as unknown as AuditViewerService;
    const controller = new AuditViewerController(service);

    const result = await controller.listPortal({});

    expect(result.meta.total).toBe(1);
  });
});

describe('GET /audit/portal/export', () => {
  it('sets CSV headers, streams the header row plus every batch, and ends the response', async () => {
    const portalRow = {
      id: '1',
      eventType: 'login_succeeded',
      actorId: 7,
      actorRole: 'maker',
      targetType: null,
      targetId: null,
      countryId: 3,
      tenantId: 9,
      ipAddress: '10.0.0.4',
      detail: { note: 'ok' },
      occurredAt: new Date('2026-08-19T00:00:00.000Z'),
    };
    const service = {
      streamPortalAudit: jest.fn(async (_query, onBatch: (rows: unknown[]) => Promise<void>) => {
        await onBatch([portalRow]);
        return { truncated: true };
      }),
    } as unknown as AuditViewerService;
    const controller = new AuditViewerController(service);
    const { response, chunks, headers } = fakeResponse();

    await controller.exportPortal({}, response);

    expect(headers['Content-Type']).toContain('text/csv');
    expect(chunks[0]).toBe(
      'id,eventType,actorId,actorRole,targetType,targetId,countryId,tenantId,ipAddress,occurredAt,detail\r\n',
    );
    expect(chunks.some((c) => c.startsWith('1,login_succeeded,7,maker,'))).toBe(true);
    expect(chunks.some((c) => c.includes('truncated at'))).toBe(true);
    expect(response.end as jest.Mock).toHaveBeenCalled();
  });

  it('renders a null detail as an empty cell, not the string "null"', async () => {
    const portalRow = {
      id: '1',
      eventType: 'login_succeeded',
      actorId: null,
      actorRole: null,
      targetType: null,
      targetId: null,
      countryId: null,
      tenantId: null,
      ipAddress: null,
      detail: null,
      occurredAt: new Date('2026-08-19T00:00:00.000Z'),
    };
    const service = {
      streamPortalAudit: jest.fn(async (_query, onBatch: (rows: unknown[]) => Promise<void>) => {
        await onBatch([portalRow]);
        return { truncated: false };
      }),
    } as unknown as AuditViewerService;
    const controller = new AuditViewerController(service);
    const { response, chunks } = fakeResponse();

    await controller.exportPortal({}, response);

    expect(chunks[1]).toBe('1,login_succeeded,,,,,,,,2026-08-19T00:00:00.000Z,\r\n');
  });
});

describe('TC-17 — no mutating route', () => {
  it('the controller class declares only @Get handlers', () => {
    const proto = AuditViewerController.prototype as unknown as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor');
    expect(methodNames).toEqual(
      expect.arrayContaining(['listCampaigns', 'exportCampaigns', 'listPortal', 'exportPortal']),
    );
    // No `create`/`update`/`remove`/`delete`/`patch`-shaped method exists on this controller at all.
    expect(methodNames.some((name) => /create|update|remove|delete|patch/i.test(name))).toBe(false);
  });
});
