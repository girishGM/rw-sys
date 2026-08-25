import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RoleSummary } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const { mockUseRolesQuery } = vi.hoisted(() => ({ mockUseRolesQuery: vi.fn() }));

vi.mock('./api', () => ({ useRolesQuery: mockUseRolesQuery }));
// Each editor pulls in its own query/mutation hooks (tested independently in their own specs);
// stubbed here so this suite exercises only the role-tab orchestration this page owns.
vi.mock('./NavConfigEditor', () => ({
  NavConfigEditor: ({ role }: { role: string }) => <div data-testid="nav-editor">{role}</div>,
}));
vi.mock('./PermissionsMatrixEditor', () => ({
  PermissionsMatrixEditor: ({ role }: { role: string }) => (
    <div data-testid="permissions-editor">{role}</div>
  ),
}));
vi.mock('./WidgetsConfigEditor', () => ({
  WidgetsConfigEditor: ({ role }: { role: string }) => (
    <div data-testid="widgets-editor">{role}</div>
  ),
}));
vi.mock('./PreviewModal', () => ({
  PreviewModal: ({ open, role }: { open: boolean; role: string }) =>
    open ? <div data-testid="preview-modal">{role}</div> : null,
}));

import { AccessControlPage } from './AccessControlPage';

const roles: readonly RoleSummary[] = [
  { role: 'super_admin', userCount: 2 },
  { role: 'country_admin', userCount: 1 },
  { role: 'tenant_admin', userCount: 3 },
  { role: 'maker', userCount: 5 },
  { role: 'checker', userCount: 4 },
  { role: 'merchant', userCount: 8 },
];

beforeEach(() => {
  mockUseRolesQuery.mockReset();
});

describe('AccessControlPage — TC-1', () => {
  it('lists all six roles as tabs, each with its user count', () => {
    mockUseRolesQuery.mockReturnValue({ data: roles, isLoading: false, error: null });
    render(<AccessControlPage />);

    for (const summary of roles) {
      expect(screen.getByText(new RegExp(`${String(summary.userCount)} user`))).toBeInTheDocument();
    }
  });

  it('defaults to the super_admin tab, showing its three sections', () => {
    mockUseRolesQuery.mockReturnValue({ data: roles, isLoading: false, error: null });
    render(<AccessControlPage />);

    expect(screen.getAllByTestId('nav-editor')[0]).toHaveTextContent('super_admin');
  });

  it('switching role tabs re-renders each editor for the newly selected role', async () => {
    mockUseRolesQuery.mockReturnValue({ data: roles, isLoading: false, error: null });
    const user = userEvent.setup();
    render(<AccessControlPage />);

    await user.click(screen.getByRole('tab', { name: /Maker/ }));
    expect(screen.getAllByTestId('nav-editor')[0]).toHaveTextContent('maker');
  });

  it('opens the preview modal for the active role', async () => {
    mockUseRolesQuery.mockReturnValue({ data: roles, isLoading: false, error: null });
    const user = userEvent.setup();
    render(<AccessControlPage />);

    await user.click(screen.getByRole('button', { name: /Preview/ }));
    expect(screen.getByTestId('preview-modal')).toHaveTextContent('super_admin');
  });

  it('shows a loading state while roles are loading', () => {
    mockUseRolesQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = render(<AccessControlPage />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('shows the server error message when the roles request fails', () => {
    mockUseRolesQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ApiError({ code: 'PERM_DENIED', message: 'No.', status: 403 }),
    });
    render(<AccessControlPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('No.');
  });
});
