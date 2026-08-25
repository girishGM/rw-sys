import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  EntityCatalogueEntry,
  NavConfigResponse,
  PermissionsResponse,
  PreviewResponse,
  RoleSummary,
  WidgetConfigResponse,
} from '@reward-portal/shared';

const { mockGet, mockPost, mockPut, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, put: mockPut, patch: mockPatch },
}));

import {
  fetchEntities,
  fetchNav,
  fetchPermissions,
  fetchRoles,
  fetchWidgets,
  preview,
  putNav,
  putPermissions,
  putWidgets,
  reorderNav,
  reorderWidgets,
} from './api';
import { ApiError } from '../../lib/apiError';

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPut.mockReset();
  mockPatch.mockReset();
});

const roles: readonly RoleSummary[] = [{ role: 'maker', userCount: 2 }];

describe('fetchRoles — TC-1', () => {
  it('requests /admin/access-control/roles and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: roles } });
    const result = await fetchRoles();
    expect(mockGet).toHaveBeenCalledWith('/admin/access-control/roles');
    expect(result).toEqual(roles);
  });

  it('maps a 403 into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchRoles().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ role: 'not_a_role', userCount: 1 }] } });
    await expect(fetchRoles()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('fetchEntities', () => {
  it('requests /admin/access-control/entities and unwraps {data}', async () => {
    const entities: readonly EntityCatalogueEntry[] = [
      { entity: 'rule', actions: ['view', 'create'], protectedActions: ['create'] },
    ];
    mockGet.mockResolvedValue({ data: { data: entities } });
    const result = await fetchEntities();
    expect(mockGet).toHaveBeenCalledWith('/admin/access-control/entities');
    expect(result).toEqual(entities);
  });
});

const navResponse: NavConfigResponse = {
  role: 'maker',
  version: 3,
  items: [
    {
      navKey: 'dashboard',
      label: 'Dashboard',
      icon: null,
      path: '/dashboard',
      parentNavKey: null,
      sortOrder: 10,
      enabled: true,
    },
  ],
};

describe('nav', () => {
  it('fetchNav requests /admin/access-control/nav/:role', async () => {
    mockGet.mockResolvedValue({ data: { data: navResponse } });
    const result = await fetchNav('maker');
    expect(mockGet).toHaveBeenCalledWith('/admin/access-control/nav/maker');
    expect(result).toEqual(navResponse);
  });

  it('putNav sends expectedVersion and items, unwraps {data}', async () => {
    mockPut.mockResolvedValue({ data: { data: navResponse } });
    const result = await putNav('maker', { expectedVersion: 2, items: navResponse.items });
    expect(mockPut).toHaveBeenCalledWith('/admin/access-control/nav/maker', {
      expectedVersion: 2,
      items: navResponse.items,
    });
    expect(result).toEqual(navResponse);
  });

  it('putNav maps a 422 CANNOT_LOCK_OUT_SUPER_ADMIN into an ApiError (TC-11)', async () => {
    mockPut.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: { error: { code: 'CANNOT_LOCK_OUT_SUPER_ADMIN', message: 'No.' } },
      },
    });
    const error = await putNav('super_admin', { expectedVersion: 1, items: [] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('CANNOT_LOCK_OUT_SUPER_ADMIN');
  });

  it('reorderNav PATCHes .../nav/:role/reorder — a single bulk call', async () => {
    mockPatch.mockResolvedValue({ data: { data: navResponse } });
    const result = await reorderNav('maker', {
      expectedVersion: 2,
      order: [{ key: 'dashboard', sortOrder: 20 }],
    });
    expect(mockPatch).toHaveBeenCalledWith('/admin/access-control/nav/maker/reorder', {
      expectedVersion: 2,
      order: [{ key: 'dashboard', sortOrder: 20 }],
    });
    expect(result).toEqual(navResponse);
  });
});

const widgetsResponse: WidgetConfigResponse = {
  role: 'maker',
  version: 1,
  items: [
    { widgetKey: 'kpi_my_drafts', label: 'My Drafts', config: {}, sortOrder: 10, enabled: true },
  ],
};

describe('widgets', () => {
  it('fetchWidgets requests /admin/access-control/widgets/:role', async () => {
    mockGet.mockResolvedValue({ data: { data: widgetsResponse } });
    const result = await fetchWidgets('maker');
    expect(mockGet).toHaveBeenCalledWith('/admin/access-control/widgets/maker');
    expect(result).toEqual(widgetsResponse);
  });

  it('putWidgets sends expectedVersion and items', async () => {
    mockPut.mockResolvedValue({ data: { data: widgetsResponse } });
    await putWidgets('maker', { expectedVersion: 1, items: widgetsResponse.items });
    expect(mockPut).toHaveBeenCalledWith('/admin/access-control/widgets/maker', {
      expectedVersion: 1,
      items: widgetsResponse.items,
    });
  });

  it('reorderWidgets PATCHes .../widgets/:role/reorder', async () => {
    mockPatch.mockResolvedValue({ data: { data: widgetsResponse } });
    await reorderWidgets('maker', {
      expectedVersion: 1,
      order: [{ key: 'kpi_my_drafts', sortOrder: 20 }],
    });
    expect(mockPatch).toHaveBeenCalledWith('/admin/access-control/widgets/maker/reorder', {
      expectedVersion: 1,
      order: [{ key: 'kpi_my_drafts', sortOrder: 20 }],
    });
  });
});

const permissionsResponse: PermissionsResponse = {
  role: 'maker',
  version: 1,
  permissions: { campaign: ['view'] },
};

describe('permissions', () => {
  it('fetchPermissions requests /admin/access-control/permissions/:role', async () => {
    mockGet.mockResolvedValue({ data: { data: permissionsResponse } });
    const result = await fetchPermissions('maker');
    expect(mockGet).toHaveBeenCalledWith('/admin/access-control/permissions/maker');
    expect(result).toEqual(permissionsResponse);
  });

  it('putPermissions sends expectedVersion and permissions', async () => {
    mockPut.mockResolvedValue({ data: { data: permissionsResponse } });
    await putPermissions('maker', { expectedVersion: 1, permissions: { campaign: ['view'] } });
    expect(mockPut).toHaveBeenCalledWith('/admin/access-control/permissions/maker', {
      expectedVersion: 1,
      permissions: { campaign: ['view'] },
    });
  });

  it('putPermissions maps a 422 PROTECTED_PERMISSION into an ApiError (TC-13/TC-14)', async () => {
    mockPut.mockRejectedValue({
      isAxiosError: true,
      response: { status: 422, data: { error: { code: 'PROTECTED_PERMISSION', message: 'No.' } } },
    });
    const error = await putPermissions('maker', {
      expectedVersion: 1,
      permissions: { rule: ['create'] },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PROTECTED_PERMISSION');
  });

  it('putPermissions maps a 409 version conflict into an ApiError (TC-22)', async () => {
    mockPut.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'ACCESS_CONTROL_VERSION_CONFLICT', message: 'Stale.' } },
      },
    });
    const error = await putPermissions('maker', { expectedVersion: 1, permissions: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
  });
});

describe('preview — TC-17', () => {
  it('POSTs /admin/access-control/preview and unwraps {data}', async () => {
    const previewResponse: PreviewResponse = {
      role: 'merchant',
      nav: [],
      permissions: {},
      widgets: [],
    };
    mockPost.mockResolvedValue({ data: { data: previewResponse } });
    const result = await preview({ role: 'merchant' });
    expect(mockPost).toHaveBeenCalledWith('/admin/access-control/preview', { role: 'merchant' });
    expect(result).toEqual(previewResponse);
  });
});
