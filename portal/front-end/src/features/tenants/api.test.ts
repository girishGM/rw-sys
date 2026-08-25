import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  BudgetCeiling,
  Tenant,
  TenantAdminCreated,
  CreateTenantResponse,
} from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch, mockPut } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockPut: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch, put: mockPut },
}));

import {
  activateTenant,
  budgetCeilingsQueryKey,
  createTenant,
  createTenantAdmin,
  fetchBudgetCeilings,
  fetchTenant,
  fetchTenants,
  fetchTenantsWithoutCeiling,
  tenantQueryKey,
  tenantsQueryKey,
  updateTenant,
  upsertBudgetCeiling,
} from './api';
import { ApiError } from '../../lib/apiError';

const tenant: Tenant = {
  id: 10,
  code: 'T001',
  name: 'Acme Retail',
  countryId: 1,
  schemaPrefix: null,
  contactEmail: null,
  contactPhone: null,
  status: 'pending_provisioning',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const ceiling: BudgetCeiling = {
  id: 1,
  tenantId: 10,
  unitType: 'currency',
  unitCode: 'MYR',
  maxCampaignBudget: '5000000.0000',
  warnAboveAmount: '4000000.0000',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockPut.mockReset();
});

describe('query keys', () => {
  it('tenantsQueryKey is scoped per params', () => {
    expect(tenantsQueryKey({ page: 1 })).toEqual(['tenants', { page: 1 }]);
  });

  it('tenantQueryKey is scoped per id', () => {
    expect(tenantQueryKey(10)).toEqual(['tenants', 10]);
  });

  it('budgetCeilingsQueryKey is scoped per tenant id and distinct from tenantQueryKey', () => {
    expect(budgetCeilingsQueryKey(10)).toEqual(['tenants', 10, 'budget-ceilings']);
  });
});

describe('fetchTenants', () => {
  it('requests /tenants with the given params and returns the parsed list', async () => {
    mockGet.mockResolvedValue({
      data: { data: [tenant], meta: { page: 1, pageSize: 20, total: 1 } },
    });

    const result = await fetchTenants({ page: 1, sort: 'name:asc' });

    expect(mockGet).toHaveBeenCalledWith('/tenants', { params: { page: 1, sort: 'name:asc' } });
    expect(result.data).toEqual([tenant]);
    expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 'not-a-number' }] } });
    await expect(fetchTenants({})).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchTenants({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });
});

describe('fetchTenant', () => {
  it('requests /tenants/:id and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: tenant } });
    const result = await fetchTenant(10);
    expect(mockGet).toHaveBeenCalledWith('/tenants/10');
    expect(result).toEqual(tenant);
  });

  it('throws an ApiError on a shape mismatch', async () => {
    mockGet.mockResolvedValue({ data: { data: {} } });
    await expect(fetchTenant(10)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('createTenant', () => {
  it('posts to /tenants and returns {tenant, admin} — no countryId in the request (note 2)', async () => {
    const response: CreateTenantResponse = { tenant, admin: null };
    mockPost.mockResolvedValue({ data: { data: response } });

    const result = await createTenant({ code: 'T001', name: 'Acme Retail' });

    expect(mockPost).toHaveBeenCalledWith(
      '/tenants',
      expect.objectContaining({ code: 'T001', name: 'Acme Retail' }),
    );
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('countryId');
    expect(result).toEqual(response);
  });

  it('maps a duplicate-code conflict into an ApiError (TC-10)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'TENANT_CODE_EXISTS', message: 'Already exists.' } },
      },
    });

    const error = await createTenant({ code: 'T001', name: 'Acme Retail' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('TENANT_CODE_EXISTS');
  });
});

describe('createTenantAdmin', () => {
  it('posts to /tenants/:id/admins and returns the one-time credential', async () => {
    const admin: TenantAdminCreated = {
      id: 5,
      email: 'admin@example.invalid',
      displayName: 'Admin',
      role: 'tenant_admin',
      tenantId: 10,
      temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
    };
    mockPost.mockResolvedValue({ data: { data: admin } });

    const result = await createTenantAdmin(10, {
      email: 'admin@example.invalid',
      displayName: 'Admin',
    });

    expect(mockPost).toHaveBeenCalledWith('/tenants/10/admins', {
      email: 'admin@example.invalid',
      displayName: 'Admin',
    });
    expect(result).toEqual(admin);
  });
});

describe('activateTenant', () => {
  it('posts to /tenants/:id/activate and returns the updated tenant (TC-15)', async () => {
    mockPost.mockResolvedValue({ data: { data: { ...tenant, status: 'active' } } });
    const result = await activateTenant(10);
    expect(mockPost).toHaveBeenCalledWith('/tenants/10/activate', {});
    expect(result.status).toBe('active');
  });

  it('maps an already-active conflict into an ApiError (TC-16)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'TENANT_ALREADY_ACTIVE', message: 'Already active.' } },
      },
    });
    const error = await activateTenant(10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('TENANT_ALREADY_ACTIVE');
  });
});

describe('updateTenant', () => {
  it('patches /tenants/:id and returns the updated tenant', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...tenant, status: 'suspended' } } });

    const result = await updateTenant(10, { status: 'suspended' });

    expect(mockPatch).toHaveBeenCalledWith('/tenants/10', { status: 'suspended' });
    expect(result.status).toBe('suspended');
  });
});

describe('fetchBudgetCeilings', () => {
  it('requests /tenants/:id/budget-ceilings and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: [ceiling] } });
    const result = await fetchBudgetCeilings(10);
    expect(mockGet).toHaveBeenCalledWith('/tenants/10/budget-ceilings');
    expect(result).toEqual([ceiling]);
  });

  it('maps a 404 (out-of-scope tenant, TC-26) into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'Not found.' } } },
    });
    const error = await fetchBudgetCeilings(999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('upsertBudgetCeiling', () => {
  it('puts to /tenants/:id/budget-ceilings and returns the full ceiling list (TC-21/TC-22)', async () => {
    mockPut.mockResolvedValue({ data: { data: [ceiling] } });

    const result = await upsertBudgetCeiling(10, {
      unitType: 'currency',
      unitCode: 'MYR',
      maxCampaignBudget: '5000000',
      warnAboveAmount: '4000000',
    });

    expect(mockPut).toHaveBeenCalledWith('/tenants/10/budget-ceilings', {
      unitType: 'currency',
      unitCode: 'MYR',
      maxCampaignBudget: '5000000',
      warnAboveAmount: '4000000',
    });
    expect(result).toEqual([ceiling]);
  });

  it('maps a warn-above-ceiling validation failure into an ApiError (TC-27)', async () => {
    mockPut.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Invalid.',
            details: [{ field: 'warnAboveAmount', code: 'WARN_ABOVE_NOT_EXCEEDING_CEILING' }],
          },
        },
      },
    });

    const error = await upsertBudgetCeiling(10, {
      unitType: 'currency',
      unitCode: 'MYR',
      maxCampaignBudget: '5000000',
      warnAboveAmount: '6000000',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('fetchTenantsWithoutCeiling', () => {
  it('requests /tenants/without-budget-ceiling and returns the parsed list (TC-28)', async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ id: 10, code: 'T001', name: 'Acme Retail', countryId: 1 }] },
    });

    const result = await fetchTenantsWithoutCeiling();

    expect(mockGet).toHaveBeenCalledWith('/tenants/without-budget-ceiling');
    expect(result).toEqual([{ id: 10, code: 'T001', name: 'Acme Retail', countryId: 1 }]);
  });
});
