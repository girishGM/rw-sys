import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NavConfigResponse } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const {
  mockUseNavQuery,
  mockUsePutNavMutation,
  mockUseReorderNavMutation,
  mockPutMutate,
  mockReorderMutate,
} = vi.hoisted(() => ({
  mockUseNavQuery: vi.fn(),
  mockUsePutNavMutation: vi.fn(),
  mockUseReorderNavMutation: vi.fn(),
  mockPutMutate: vi.fn(),
  mockReorderMutate: vi.fn(),
}));

vi.mock('./api', () => ({
  useNavQuery: mockUseNavQuery,
  usePutNavMutation: mockUsePutNavMutation,
  useReorderNavMutation: mockUseReorderNavMutation,
}));

import { NavConfigEditor } from './NavConfigEditor';

const superAdminNav: NavConfigResponse = {
  role: 'super_admin',
  version: 5,
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
    {
      navKey: 'access_control',
      label: 'Access Control',
      icon: null,
      path: '/admin/access-control',
      parentNavKey: null,
      sortOrder: 60,
      enabled: true,
    },
  ],
};

beforeEach(() => {
  mockUseNavQuery.mockReset();
  mockUsePutNavMutation.mockReset();
  mockUseReorderNavMutation.mockReset();
  mockPutMutate.mockReset();
  mockReorderMutate.mockReset();
  mockUsePutNavMutation.mockReturnValue({ mutate: mockPutMutate, isPending: false, error: null });
  mockUseReorderNavMutation.mockReturnValue({ mutate: mockReorderMutate, isPending: false });
});

describe('NavConfigEditor', () => {
  it('renders every item for the role', () => {
    mockUseNavQuery.mockReturnValue({ data: superAdminNav, isLoading: false });
    render(<NavConfigEditor role="super_admin" />);
    expect(screen.getByDisplayValue('Dashboard')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Access Control')).toBeInTheDocument();
  });

  it("disables the access_control row's toggle and remove button for super_admin (implementation note 2, verification step 4)", () => {
    mockUseNavQuery.mockReturnValue({ data: superAdminNav, isLoading: false });
    render(<NavConfigEditor role="super_admin" />);

    const toggle = screen.getByRole('switch', { name: 'Enabled: Access Control' });
    expect(toggle).toBeDisabled();
    const remove = screen.getByRole('button', { name: 'Remove Access Control' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', expect.stringContaining('super_admin'));
  });

  it('does not lock the access_control row for any other role', () => {
    mockUseNavQuery.mockReturnValue({
      data: { ...superAdminNav, role: 'maker' },
      isLoading: false,
    });
    render(<NavConfigEditor role="maker" />);
    expect(screen.getByRole('switch', { name: 'Enabled: Access Control' })).not.toBeDisabled();
  });

  it('Save is disabled until a field changes, and enabled once the draft is dirty', async () => {
    mockUseNavQuery.mockReturnValue({ data: superAdminNav, isLoading: false });
    const user = userEvent.setup();
    render(<NavConfigEditor role="super_admin" />);

    const save = screen.getByRole('button', { name: 'Save navigation' });
    expect(save).toBeDisabled();

    await user.type(screen.getByDisplayValue('Dashboard'), ' Home');

    expect(screen.getByRole('button', { name: 'Save navigation' })).not.toBeDisabled();
  });

  it('Save submits expectedVersion and the current items', async () => {
    mockUseNavQuery.mockReturnValue({ data: superAdminNav, isLoading: false });
    const user = userEvent.setup();
    render(<NavConfigEditor role="super_admin" />);

    const dashboardInput = screen.getByDisplayValue('Dashboard');
    await user.type(dashboardInput, ' 2');
    await user.click(screen.getByRole('button', { name: 'Save navigation' }));

    expect(mockPutMutate).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 5 }));
  });

  it('moving an item up issues a single reorder call (implementation note 7)', async () => {
    mockUseNavQuery.mockReturnValue({ data: superAdminNav, isLoading: false });
    const user = userEvent.setup();
    render(<NavConfigEditor role="super_admin" />);

    await user.click(screen.getByRole('button', { name: 'Move Access Control up' }));

    expect(mockReorderMutate).toHaveBeenCalledTimes(1);
    expect(mockReorderMutate).toHaveBeenCalledWith({
      expectedVersion: 5,
      order: [
        { key: 'access_control', sortOrder: 10 },
        { key: 'dashboard', sortOrder: 20 },
      ],
    });
  });

  it('shows a conflict message and a reload action on a 409 (TC-22)', async () => {
    const refetch = vi.fn();
    mockUseNavQuery.mockReturnValue({ data: superAdminNav, isLoading: false, refetch });
    mockUsePutNavMutation.mockReturnValue({
      mutate: mockPutMutate,
      isPending: false,
      error: new ApiError({
        code: 'ACCESS_CONTROL_VERSION_CONFLICT',
        message: 'Stale.',
        status: 409,
      }),
    });
    const user = userEvent.setup();
    render(<NavConfigEditor role="super_admin" />);

    expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
    await user.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the server error message for a 422 lock-out rejection (TC-11)', () => {
    mockUseNavQuery.mockReturnValue({ data: superAdminNav, isLoading: false });
    mockUsePutNavMutation.mockReturnValue({
      mutate: mockPutMutate,
      isPending: false,
      error: new ApiError({
        code: 'CANNOT_LOCK_OUT_SUPER_ADMIN',
        message: 'You cannot remove your own access to this screen.',
        status: 422,
      }),
    });
    render(<NavConfigEditor role="super_admin" />);

    expect(screen.getByRole('alert')).toHaveTextContent('cannot remove your own access');
  });

  it('renders a loading skeleton while the query is pending', () => {
    mockUseNavQuery.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<NavConfigEditor role="maker" />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('Add item appends a new draft row', async () => {
    mockUseNavQuery.mockReturnValue({ data: superAdminNav, isLoading: false });
    const user = userEvent.setup();
    render(<NavConfigEditor role="super_admin" />);

    await user.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.getByDisplayValue('New item')).toBeInTheDocument();
  });
});
