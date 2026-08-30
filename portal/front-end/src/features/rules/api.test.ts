import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Rule, RuleCountryAssignment } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch, delete: mockDelete },
}));

import {
  assignRuleCountry,
  createRule,
  deleteRule,
  fetchFieldApiLookupProviders,
  fetchFieldContextProviders,
  fetchRule,
  fetchRuleCategories,
  fetchRuleCountries,
  fetchRuleParameters,
  fetchRules,
  fetchRuleSubCategories,
  ruleCountriesQueryKey,
  ruleParametersQueryKey,
  ruleQueryKey,
  rulesQueryKey,
  unassignRuleCountry,
  updateRule,
} from './api';
import { ApiError } from '../../lib/apiError';

const rule: Rule = {
  id: 1,
  ruleCode: 'MIN_SPEND_TIER',
  name: 'Minimum spend tier',
  categoryId: 13,
  categoryName: 'TRANSACTION',
  subCategoryId: 13,
  subCategoryName: 'General',
  expression: 'amount >= :minSpend',
  parameters: { fields: [] },
  status: 'active',
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const assignment: RuleCountryAssignment = {
  id: 500,
  ruleId: 1,
  countryId: 2,
  countryCode: 'SG',
  countryName: 'Singapore',
  assignedAt: '2026-01-01T00:00:00.000Z',
  assignedBy: null,
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockDelete.mockReset();
});

describe('query keys', () => {
  it('rulesQueryKey is scoped per params', () => {
    expect(rulesQueryKey({ page: 1 })).toEqual(['rules', { page: 1 }]);
  });

  it('ruleQueryKey is scoped per id', () => {
    expect(ruleQueryKey(7)).toEqual(['rules', 7]);
  });

  it('ruleParametersQueryKey and ruleCountriesQueryKey are distinct per id', () => {
    expect(ruleParametersQueryKey(7)).toEqual(['rules', 7, 'parameters']);
    expect(ruleCountriesQueryKey(7)).toEqual(['rules', 7, 'countries']);
  });
});

describe('fetchRules', () => {
  it('requests /rules with the given params and returns the parsed list', async () => {
    mockGet.mockResolvedValue({
      data: { data: [rule], meta: { page: 1, pageSize: 20, total: 1 } },
    });

    const result = await fetchRules({ page: 1, sort: 'name:asc' });

    expect(mockGet).toHaveBeenCalledWith('/rules', { params: { page: 1, sort: 'name:asc' } });
    expect(result.data).toEqual([rule]);
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 'not-a-number' }] } });
    await expect(fetchRules({})).rejects.toBeInstanceOf(ApiError);
  });

  // T-074 — reproduced live: a rule with no parameters came back from the server as
  // `parameters: {}` (rather than `{ fields: [] }`), which the shared schema used to reject —
  // failing this whole list, not just that one row, and surfacing as "Something went wrong"
  // on the real Rules screen even though the HTTP response was a genuine 200.
  it('does not throw when a rule with no parameters comes back as {} (T-074)', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [{ ...rule, parameters: {} }],
        meta: { page: 1, pageSize: 20, total: 1 },
      },
    });

    const result = await fetchRules({});

    expect(result.data[0]?.parameters).toEqual({ fields: [] });
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchRules({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });
});

describe('fetchRule', () => {
  it('requests /rules/:id and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: rule } });
    const result = await fetchRule(1);
    expect(mockGet).toHaveBeenCalledWith('/rules/1');
    expect(result).toEqual(rule);
  });

  it('a rule not visible to the caller (404) maps into an ApiError (TC-8)', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'Not found.' } } },
    });
    const error = await fetchRule(999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});

describe('fetchRuleParameters', () => {
  it('requests /rules/:id/parameters and unwraps {data} (TC-15)', async () => {
    // T-114 — every field now also carries a response-only `role`; the response is
    // role-annotated even though the request that authored these fields never was.
    const parameters = {
      fields: [
        {
          key: 'minSpend',
          label: 'Minimum spend',
          type: 'number',
          required: true,
          role: 'compare_value',
        },
      ],
    };
    mockGet.mockResolvedValue({ data: { data: parameters } });

    const result = await fetchRuleParameters(1);

    expect(mockGet).toHaveBeenCalledWith('/rules/1/parameters');
    expect(result).toEqual(parameters);
  });
});

describe('fetchRuleCountries', () => {
  it('requests /rules/:id/countries and returns the assignment list', async () => {
    mockGet.mockResolvedValue({ data: { data: [assignment] } });
    const result = await fetchRuleCountries(1);
    expect(mockGet).toHaveBeenCalledWith('/rules/1/countries');
    expect(result).toEqual([assignment]);
  });
});

describe('createRule', () => {
  it('posts to /rules and returns the created rule (TC-1)', async () => {
    mockPost.mockResolvedValue({ data: { data: rule } });

    const result = await createRule({
      ruleCode: 'MIN_SPEND_TIER',
      name: 'Minimum spend tier',
      subCategoryId: 13,
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/rules',
      expect.objectContaining({ ruleCode: 'MIN_SPEND_TIER' }),
    );
    expect(result).toEqual(rule);
  });

  it('maps a duplicate-code conflict into an ApiError (TC-18)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'RULE_CODE_EXISTS', message: 'Already exists.' } },
      },
    });

    const error = await createRule({ ruleCode: 'XX', name: 'x', subCategoryId: 13 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('RULE_CODE_EXISTS');
  });

  it('maps a malformed-parameters failure into an ApiError (TC-14)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Invalid.',
            details: [{ field: 'parameters', code: 'IS_RULE_PARAMETERS' }],
          },
        },
      },
    });

    const error = await createRule({ ruleCode: 'XX', name: 'x', subCategoryId: 13 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VALIDATION_FAILED');
  });
});

describe('updateRule', () => {
  it('patches /rules/:id and returns the updated rule (TC-19)', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...rule, name: 'New name' } } });

    const result = await updateRule(1, { name: 'New name' });

    expect(mockPatch).toHaveBeenCalledWith('/rules/1', { name: 'New name' });
    expect(result.name).toBe('New name');
  });

  it('maps a 403 (e.g. a maker) into an ApiError (TC-21)', async () => {
    mockPatch.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await updateRule(1, { name: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });
});

describe('deleteRule', () => {
  it('deletes /rules/:id', async () => {
    mockDelete.mockResolvedValue({ status: 204 });
    await deleteRule(1);
    expect(mockDelete).toHaveBeenCalledWith('/rules/1');
  });

  it('maps a 422 (still assigned) into an ApiError (TC-20)', async () => {
    mockDelete.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: { error: { code: 'RULE_HAS_COUNTRY_ASSIGNMENTS', message: 'Unassign first.' } },
      },
    });
    const error = await deleteRule(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('RULE_HAS_COUNTRY_ASSIGNMENTS');
  });
});

describe('assignRuleCountry', () => {
  it('posts to /rules/:id/countries and returns the assignment (TC-10)', async () => {
    mockPost.mockResolvedValue({ data: { data: assignment } });

    const result = await assignRuleCountry(1, { countryId: 2 });

    expect(mockPost).toHaveBeenCalledWith('/rules/1/countries', { countryId: 2 });
    expect(result).toEqual(assignment);
  });
});

describe('unassignRuleCountry', () => {
  it('deletes /rules/:id/countries/:countryId', async () => {
    mockDelete.mockResolvedValue({ status: 204 });
    await unassignRuleCountry(1, 2);
    expect(mockDelete).toHaveBeenCalledWith('/rules/1/countries/2');
  });

  it('maps a 422 (bound to an active campaign) into an ApiError (TC-12)', async () => {
    mockDelete.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: {
          error: {
            code: 'RULE_IN_USE_BY_CAMPAIGN',
            message: 'In use.',
            details: [{ field: 'campaignId', code: 'CAMPAIGN_55' }],
          },
        },
      },
    });
    const error = await unassignRuleCountry(1, 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('RULE_IN_USE_BY_CAMPAIGN');
  });
});

describe('reference data', () => {
  it('fetchRuleCategories requests /rule-categories', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [{ id: 13, categoryCode: 'TRANSACTION', name: 'TRANSACTION', status: 'active' }],
      },
    });
    const result = await fetchRuleCategories();
    expect(mockGet).toHaveBeenCalledWith('/rule-categories');
    expect(result).toHaveLength(1);
  });

  it('fetchRuleSubCategories requests /rule-sub-categories with an optional categoryId', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [
          { id: 13, categoryId: 13, subCategoryCode: 'GENERAL', name: 'General', status: 'active' },
        ],
      },
    });

    await fetchRuleSubCategories(13);
    expect(mockGet).toHaveBeenCalledWith('/rule-sub-categories', { params: { categoryId: 13 } });

    await fetchRuleSubCategories(undefined);
    expect(mockGet).toHaveBeenLastCalledWith('/rule-sub-categories', { params: {} });
  });
});

// T-125 — the field builder's "Where do the options come from?" picker reads these two.
describe('field value-source registries', () => {
  it('fetchFieldContextProviders requests /field-context-providers', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [
          {
            id: 1,
            providerCode: 'SIBLING_COMPONENTS',
            name: 'Sibling components',
            description: null,
            status: 'active',
          },
        ],
      },
    });
    const result = await fetchFieldContextProviders();
    expect(mockGet).toHaveBeenCalledWith('/field-context-providers');
    expect(result).toHaveLength(1);
  });

  it('fetchFieldApiLookupProviders requests /field-api-lookup-providers', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [
          {
            id: 1,
            providerCode: 'PRODUCT_CATALOG',
            name: 'Product catalog',
            description: null,
            endpointUrl: 'PLACEHOLDER',
            httpMethod: 'GET',
            authType: 'none',
            responseValueKey: 'id',
            responseLabelKey: 'name',
            status: 'planned',
          },
        ],
      },
    });
    const result = await fetchFieldApiLookupProviders();
    expect(mockGet).toHaveBeenCalledWith('/field-api-lookup-providers');
    expect(result).toHaveLength(1);
  });
});
