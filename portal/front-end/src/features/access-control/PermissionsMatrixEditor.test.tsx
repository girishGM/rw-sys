import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EntityCatalogueEntry, PermissionsResponse } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const { mockUseEntitiesQuery, mockUsePermissionsQuery, mockUsePutPermissionsMutation, mockMutate } =
  vi.hoisted(() => ({
    mockUseEntitiesQuery: vi.fn(),
    mockUsePermissionsQuery: vi.fn(),
    mockUsePutPermissionsMutation: vi.fn(),
    mockMutate: vi.fn(),
  }));

vi.mock('./api', () => ({
  useEntitiesQuery: mockUseEntitiesQuery,
  usePermissionsQuery: mockUsePermissionsQuery,
  usePutPermissionsMutation: mockUsePutPermissionsMutation,
}));

import { PermissionsMatrixEditor } from './PermissionsMatrixEditor';

const entities: readonly EntityCatalogueEntry[] = [
  { entity: 'campaign', actions: ['view', 'create'], protectedActions: [] },
  {
    entity: 'rule',
    actions: ['view', 'create', 'update', 'delete'],
    protectedActions: ['create', 'update', 'delete'],
  },
  {
    entity: 'access_control',
    actions: ['view', 'create', 'update', 'delete'],
    protectedActions: [],
  },
  { entity: 'user', actions: ['view', 'create', 'update', 'delete'], protectedActions: [] },
];

function makerPermissions(): PermissionsResponse {
  return { role: 'maker', version: 1, permissions: { campaign: ['view'], rule: ['view'] } };
}

function superAdminPermissions(): PermissionsResponse {
  return {
    role: 'super_admin',
    version: 1,
    permissions: { access_control: ['view', 'update'], user: ['create'], rule: ['view', 'create'] },
  };
}

beforeEach(() => {
  mockUseEntitiesQuery.mockReset();
  mockUsePermissionsQuery.mockReset();
  mockUsePutPermissionsMutation.mockReset();
  mockMutate.mockReset();
  mockUseEntitiesQuery.mockReturnValue({ data: entities, isLoading: false });
  mockUsePutPermissionsMutation.mockReturnValue({
    mutate: mockMutate,
    isPending: false,
    error: null,
  });
});

describe('PermissionsMatrixEditor', () => {
  it('renders one row per entity with a checkbox per allowed action', () => {
    mockUsePermissionsQuery.mockReturnValue({ data: makerPermissions(), isLoading: false });
    render(<PermissionsMatrixEditor role="maker" />);

    expect(screen.getByText('campaign')).toBeInTheDocument();
    const campaignRow = screen.getByText('campaign').closest('tr');
    expect(within(campaignRow!).getByRole('checkbox', { name: 'view' })).toBeInTheDocument();
  });

  it('checks the boxes that match the current grant', () => {
    mockUsePermissionsQuery.mockReturnValue({ data: makerPermissions(), isLoading: false });
    render(<PermissionsMatrixEditor role="maker" />);

    const campaignRow = screen.getByText('campaign').closest('tr');
    expect(campaignRow).not.toBeNull();
    expect(campaignRow!.querySelector('input[type="checkbox"]')).toBeChecked();
  });

  it('locks rule create/update/delete for a non-super_admin role (TC-13/TC-14, implementation note 3)', () => {
    mockUsePermissionsQuery.mockReturnValue({ data: makerPermissions(), isLoading: false });
    render(<PermissionsMatrixEditor role="maker" />);

    const ruleRow = screen.getByText('rule').closest('tr');
    const createCheckbox = within(ruleRow!).getByRole('checkbox', { name: 'create' });
    expect(createCheckbox).toBeDisabled();
    expect(createCheckbox).toHaveAttribute(
      'title',
      expect.stringContaining('reserved for super_admin'),
    );
  });

  it('does not lock rule create/update/delete for super_admin', () => {
    mockUsePermissionsQuery.mockReturnValue({ data: superAdminPermissions(), isLoading: false });
    render(<PermissionsMatrixEditor role="super_admin" />);

    const ruleRow = screen.getByText('rule').closest('tr');
    expect(within(ruleRow!).getByRole('checkbox', { name: 'create' })).not.toBeDisabled();
  });

  it('locks access_control view/update and user:create when editing super_admin (TC-11)', () => {
    mockUsePermissionsQuery.mockReturnValue({ data: superAdminPermissions(), isLoading: false });
    render(<PermissionsMatrixEditor role="super_admin" />);

    const accessControlRow = screen.getByText('access_control').closest('tr');
    expect(within(accessControlRow!).getByRole('checkbox', { name: 'view' })).toBeDisabled();
    expect(within(accessControlRow!).getByRole('checkbox', { name: 'update' })).toBeDisabled();
    expect(within(accessControlRow!).getByRole('checkbox', { name: 'delete' })).not.toBeDisabled();

    const userRow = screen.getByText('user').closest('tr');
    expect(within(userRow!).getByRole('checkbox', { name: 'create' })).toBeDisabled();
  });

  it('toggling a checkbox marks the draft dirty and Save submits it', async () => {
    mockUsePermissionsQuery.mockReturnValue({ data: makerPermissions(), isLoading: false });
    const user = userEvent.setup();
    render(<PermissionsMatrixEditor role="maker" />);

    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();

    const campaignRow = screen.getByText('campaign').closest('tr');
    await user.click(within(campaignRow!).getByRole('checkbox', { name: 'create' }));

    const save = screen.getByRole('button', { name: 'Save permissions' });
    expect(save).not.toBeDisabled();
    await user.click(save);

    expect(mockMutate).toHaveBeenCalledWith({
      expectedVersion: 1,
      permissions: expect.objectContaining({
        campaign: expect.arrayContaining(['view', 'create']),
      }),
    });
  });

  it(
    'unchecking a granted permission marks the draft dirty and Save submits it without that ' +
      'action (T-062 — the real screen interaction the bug report described)',
    async () => {
      mockUsePermissionsQuery.mockReturnValue({ data: makerPermissions(), isLoading: false });
      const user = userEvent.setup();
      render(<PermissionsMatrixEditor role="maker" />);

      const campaignRow = screen.getByText('campaign').closest('tr');
      const viewCheckbox = within(campaignRow!).getByRole('checkbox', { name: 'view' });
      expect(viewCheckbox).toBeChecked();

      await user.click(viewCheckbox);
      expect(viewCheckbox).not.toBeChecked();

      const save = screen.getByRole('button', { name: 'Save permissions' });
      expect(save).not.toBeDisabled();
      await user.click(save);

      expect(mockMutate).toHaveBeenCalledWith({
        expectedVersion: 1,
        permissions: expect.objectContaining({ campaign: [] }),
      });
    },
  );

  it('shows the server error for a rejected protected-permission grant (TC-13)', () => {
    mockUsePermissionsQuery.mockReturnValue({ data: makerPermissions(), isLoading: false });
    mockUsePutPermissionsMutation.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
      error: new ApiError({
        code: 'PROTECTED_PERMISSION',
        message: 'rule:create is reserved for super_admin.',
        status: 422,
      }),
    });
    render(<PermissionsMatrixEditor role="maker" />);
    expect(screen.getByRole('alert')).toHaveTextContent('reserved for super_admin');
  });

  it('names the rejected field for a VALIDATION_FAILED response (T-062)', () => {
    mockUsePermissionsQuery.mockReturnValue({ data: makerPermissions(), isLoading: false });
    mockUsePutPermissionsMutation.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
      error: new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'VALIDATION_FAILED',
        status: 400,
        details: [{ field: 'permissions', code: 'IS_PERMISSIONS_MATRIX' }],
      }),
    });
    render(<PermissionsMatrixEditor role="maker" />);
    expect(screen.getByRole('alert')).toHaveTextContent('permissions');
  });

  it('shows a conflict message and a reload action on a 409 (TC-22)', async () => {
    const refetch = vi.fn();
    mockUsePermissionsQuery.mockReturnValue({
      data: makerPermissions(),
      isLoading: false,
      refetch,
    });
    mockUsePutPermissionsMutation.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
      error: new ApiError({
        code: 'ACCESS_CONTROL_VERSION_CONFLICT',
        message: 'Stale.',
        status: 409,
      }),
    });
    const user = userEvent.setup();
    render(<PermissionsMatrixEditor role="maker" />);

    expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
    await user.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders a loading skeleton while either query is pending', () => {
    mockUseEntitiesQuery.mockReturnValue({ data: undefined, isLoading: true });
    mockUsePermissionsQuery.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<PermissionsMatrixEditor role="maker" />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
