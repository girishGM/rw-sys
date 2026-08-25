import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TraceResponse } from '@reward-portal/shared';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet } }));

import { fetchTrace, traceQueryKey } from './api';
import { ApiError } from '../../lib/apiError';

const validResponse: TraceResponse = {
  correlationId: '01J8F3K9QP2M7N',
  summary: {
    correlationId: '01J8F3K9QP2M7N',
    startedAt: null,
    durationMs: null,
    actor: null,
    scope: null,
    route: null,
    status: null,
  },
  spans: [],
  sources: {
    portalAuditLog: 'available',
    domainAudit: 'available',
    logStore: 'not_configured',
    configFetches: 'not_configured',
  },
  auditEvents: [],
  domainAudit: [],
  configFetches: [],
  logLines: null,
  truncated: false,
};

beforeEach(() => {
  mockGet.mockReset();
});

describe('traceQueryKey', () => {
  it('is scoped per correlation id', () => {
    expect(traceQueryKey('abc')).toEqual(['trace', 'abc']);
    expect(traceQueryKey('abc')).not.toBe(traceQueryKey('abc')); // new array each call
  });
});

describe('fetchTrace', () => {
  it('requests the correctly-encoded path and returns the parsed data', async () => {
    mockGet.mockResolvedValue({ data: { data: validResponse } });

    const result = await fetchTrace('01J8F3K9QP2M7N');

    expect(mockGet).toHaveBeenCalledWith('/audit/trace/01J8F3K9QP2M7N');
    expect(result).toEqual(validResponse);
  });

  it('percent-encodes the id in the URL', async () => {
    mockGet.mockResolvedValue({ data: { data: validResponse } });
    await fetchTrace('has a space');
    expect(mockGet).toHaveBeenCalledWith('/audit/trace/has%20a%20space');
  });

  it('throws an ApiError when the server response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: { correlationId: '01J8F3K9QP2M7N' } } });
    await expect(fetchTrace('01J8F3K9QP2M7N')).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 404,
        data: { error: { code: 'NOT_FOUND', message: 'Not found', traceId: 'x' } },
      },
    });

    const error = await fetchTrace('01J8F3K9QP2M7N').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('NOT_FOUND');
  });
});
