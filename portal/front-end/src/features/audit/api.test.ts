import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet } }));

import { fetchCampaignAudit, fetchPortalAudit, auditExportUrl } from './api';
import { ApiError } from '../../lib/apiError';

beforeEach(() => {
  mockGet.mockReset();
});

describe('fetchCampaignAudit', () => {
  it('requests /audit/campaigns with the whitelisted params only', async () => {
    mockGet.mockResolvedValue({ data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } } });

    await fetchCampaignAudit({ action: 'submitted', page: 1, pageSize: 20 });

    expect(mockGet).toHaveBeenCalledWith('/audit/campaigns', {
      params: { action: 'submitted', page: 1, pageSize: 20 },
    });
  });

  it('drops undefined/empty filters rather than sending them', async () => {
    mockGet.mockResolvedValue({ data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } } });

    await fetchCampaignAudit({ dateFrom: undefined, entityType: '' });

    expect(mockGet).toHaveBeenCalledWith('/audit/campaigns', { params: {} });
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 403,
        data: { error: { code: 'PERM_DENIED', message: 'no', traceId: 'x' } },
      },
    });

    await expect(fetchCampaignAudit({})).rejects.toBeInstanceOf(ApiError);
  });
});

describe('fetchPortalAudit', () => {
  it('requests /audit/portal', async () => {
    mockGet.mockResolvedValue({ data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } } });

    await fetchPortalAudit({ eventType: 'login_succeeded' });

    expect(mockGet).toHaveBeenCalledWith('/audit/portal', {
      params: { eventType: 'login_succeeded' },
    });
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: {} } });
    await expect(fetchPortalAudit({})).rejects.toBeInstanceOf(ApiError);
  });
});

describe('auditExportUrl', () => {
  it('builds the campaigns export URL with no query string when there are no filters', () => {
    expect(auditExportUrl('campaigns', {})).toBe('/api/v1/audit/campaigns/export');
  });

  it('builds the portal export URL with the filters as a query string', () => {
    expect(auditExportUrl('portal', { eventType: 'login_succeeded', page: 2 })).toBe(
      '/api/v1/audit/portal/export?eventType=login_succeeded&page=2',
    );
  });

  it('never includes an undefined or empty-string filter in the URL', () => {
    expect(auditExportUrl('campaigns', { dateFrom: undefined, action: '' })).toBe(
      '/api/v1/audit/campaigns/export',
    );
  });
});
