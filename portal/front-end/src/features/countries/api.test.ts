import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Country, CountryAdminCreated, CreateCountryResponse } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));

import {
  countriesQueryKey,
  countryQueryKey,
  countrySummaryQueryKey,
  createCountry,
  createCountryAdmin,
  fetchCountries,
  fetchCountry,
  fetchCountrySummary,
  updateCountry,
} from './api';
import { ApiError } from '../../lib/apiError';

const country: Country = {
  id: 1,
  code: 'MY',
  name: 'Malaysia',
  timezone: 'Asia/Kuala_Lumpur',
  currencyCode: 'MYR',
  dialingCode: '+60',
  isHq: false,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
});

describe('query keys', () => {
  it('countriesQueryKey is scoped per params', () => {
    expect(countriesQueryKey({ page: 1 })).toEqual(['countries', { page: 1 }]);
  });

  it('countryQueryKey is scoped per id', () => {
    expect(countryQueryKey(7)).toEqual(['countries', 7]);
  });

  it('countrySummaryQueryKey is scoped per id and distinct from countryQueryKey', () => {
    expect(countrySummaryQueryKey(7)).toEqual(['countries', 7, 'summary']);
  });
});

describe('fetchCountries', () => {
  it('requests /countries with the given params and returns the parsed list', async () => {
    mockGet.mockResolvedValue({
      data: { data: [country], meta: { page: 1, pageSize: 20, total: 1 } },
    });

    const result = await fetchCountries({ page: 1, sort: 'name:asc' });

    expect(mockGet).toHaveBeenCalledWith('/countries', { params: { page: 1, sort: 'name:asc' } });
    expect(result.data).toEqual([country]);
    expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 'not-a-number' }] } });
    await expect(fetchCountries({})).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchCountries({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });
});

describe('fetchCountry', () => {
  it('requests /countries/:id and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: country } });
    const result = await fetchCountry(1);
    expect(mockGet).toHaveBeenCalledWith('/countries/1');
    expect(result).toEqual(country);
  });

  it('throws an ApiError on a shape mismatch', async () => {
    mockGet.mockResolvedValue({ data: { data: {} } });
    await expect(fetchCountry(1)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('fetchCountrySummary', () => {
  it('requests /countries/:id/summary and unwraps {data}', async () => {
    const summary = {
      countryId: 1,
      tenantCount: 2,
      activeTenantCount: 1,
      campaignCount: 3,
      tenants: [{ id: 10, code: 'T001', name: 'A Tenant', status: 'active' }],
    };
    mockGet.mockResolvedValue({ data: { data: summary } });

    const result = await fetchCountrySummary(1);

    expect(mockGet).toHaveBeenCalledWith('/countries/1/summary');
    expect(result).toEqual(summary);
  });
});

describe('createCountry', () => {
  it('posts to /countries and returns {country, admin}', async () => {
    const response: CreateCountryResponse = { country, admin: null };
    mockPost.mockResolvedValue({ data: { data: response } });

    const result = await createCountry({
      code: 'MY',
      name: 'Malaysia',
      timezone: 'Asia/Kuala_Lumpur',
      currencyCode: 'MYR',
      dialingCode: '+60',
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/countries',
      expect.objectContaining({ code: 'MY', name: 'Malaysia' }),
    );
    expect(result).toEqual(response);
  });

  it('maps a duplicate-code conflict into an ApiError', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'COUNTRY_CODE_EXISTS', message: 'Already exists.' } },
      },
    });

    const error = await createCountry({
      code: 'MY',
      name: 'Malaysia',
      timezone: 'Asia/Kuala_Lumpur',
      currencyCode: 'MYR',
      dialingCode: '+60',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('COUNTRY_CODE_EXISTS');
  });
});

describe('createCountryAdmin', () => {
  it('posts to /countries/:id/admins and returns the one-time credential', async () => {
    const admin: CountryAdminCreated = {
      id: 5,
      email: 'admin@example.invalid',
      displayName: 'Admin',
      role: 'country_admin',
      countryId: 1,
      temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
    };
    mockPost.mockResolvedValue({ data: { data: admin } });

    const result = await createCountryAdmin(1, {
      email: 'admin@example.invalid',
      displayName: 'Admin',
    });

    expect(mockPost).toHaveBeenCalledWith('/countries/1/admins', {
      email: 'admin@example.invalid',
      displayName: 'Admin',
    });
    expect(result).toEqual(admin);
  });
});

describe('updateCountry', () => {
  it('patches /countries/:id and returns the updated country', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...country, status: 'inactive' } } });

    const result = await updateCountry(1, { status: 'inactive', confirm: true });

    expect(mockPatch).toHaveBeenCalledWith('/countries/1', { status: 'inactive', confirm: true });
    expect(result.status).toBe('inactive');
  });

  it('maps a 422 confirmation-required failure into an ApiError', async () => {
    mockPatch.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: {
          error: {
            code: 'COUNTRY_DEACTIVATION_REQUIRES_CONFIRMATION',
            message: 'Confirm required.',
          },
        },
      },
    });

    const error = await updateCountry(1, { status: 'inactive' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('COUNTRY_DEACTIVATION_REQUIRES_CONFIRMATION');
  });
});
