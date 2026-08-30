/**
 * T-125 — direct unit coverage of `ruleValues.ts`'s two value-source lookup fetchers
 * (`ComponentRulesStep.test.tsx` already exercises them indirectly through the rendered
 * `Select`s; this covers the error paths a component-level test would rather not contort itself
 * to reach — a malformed response shape and a rethrown network failure).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet } }));

import { fetchApiLookupOptions, fetchContextLookupOptions } from './ruleValues';
import { ApiError } from '../../lib/apiError';

beforeEach(() => {
  mockGet.mockReset();
});

describe('fetchContextLookupOptions', () => {
  it('requests the tracker/component-scoped context endpoint and maps { value, label } pairs', async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ value: 3, label: 'Step 1', componentCode: 'CMP_3', sequenceOrder: 1 }] },
    });

    const result = await fetchContextLookupOptions('SIBLING_COMPONENTS', 1, 5);

    expect(mockGet).toHaveBeenCalledWith('/field-value-sources/context/SIBLING_COMPONENTS', {
      params: { trackerId: 1, excludeComponentId: 5 },
    });
    expect(result).toEqual([{ value: 3, label: 'Step 1' }]);
  });

  it('omits excludeComponentId from the query when not supplied', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });

    await fetchContextLookupOptions('JOURNEY_COMPONENTS', 1);

    expect(mockGet).toHaveBeenCalledWith('/field-value-sources/context/JOURNEY_COMPONENTS', {
      params: { trackerId: 1 },
    });
  });

  it('rejects a malformed response shape rather than returning it as-is', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ notValue: 1 }] } });

    // `parseFieldValueOptionList` throws a plain `Error`; `toApiError` (the same seam every
    // other fetcher in this codebase funnels through) does not know that shape and degrades it
    // to its own generic client-side code — the point being proven here is "the malformed shape
    // never silently reaches a caller as real data", not the exact wording of the fallback.
    const error = await fetchContextLookupOptions('SIBLING_COMPONENTS', 1, 5).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UNKNOWN_ERROR');
  });

  it('maps a network/HTTP failure into an ApiError rather than letting the raw error escape', async () => {
    mockGet.mockRejectedValue(
      Object.assign(new Error('boom'), { isAxiosError: true, response: undefined }),
    );

    const error = await fetchContextLookupOptions('SIBLING_COMPONENTS', 1, 5).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('fetchApiLookupOptions', () => {
  it('requests the provider-scoped api endpoint and maps { value, label } pairs', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ value: 'SKU-1', label: 'Widget' }] } });

    const result = await fetchApiLookupOptions('PRODUCT_CATALOG');

    expect(mockGet).toHaveBeenCalledWith('/field-value-sources/api/PRODUCT_CATALOG');
    expect(result).toEqual([{ value: 'SKU-1', label: 'Widget' }]);
  });

  it('surfaces a 501 (planned provider) as an ApiError carrying that status', async () => {
    mockGet.mockRejectedValue(
      Object.assign(new Error('planned'), {
        isAxiosError: true,
        response: {
          status: 501,
          data: { error: { code: 'FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE', message: 'not yet' } },
        },
      }),
    );

    const error = await fetchApiLookupOptions('PRODUCT_CATALOG').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(501);
  });
});
