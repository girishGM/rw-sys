import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequireBootstrap } from '../../src/auth/RequireBootstrap';
import { useBootstrap, type BootstrapContextValue } from '../../src/auth/useBootstrap';

vi.mock('../../src/auth/useBootstrap', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/useBootstrap')>(
    '../../src/auth/useBootstrap',
  );
  return { ...actual, useBootstrap: vi.fn() };
});

const mockedUseBootstrap = vi.mocked(useBootstrap);

function stub(overrides: Partial<BootstrapContextValue>): BootstrapContextValue {
  return {
    user: undefined,
    scope: undefined,
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    isPasswordChangeRequired: false,
    hasPermission: () => false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function renderAtProtectedRoute(children: ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="/dashboard" element={<RequireBootstrap>{children}</RequireBootstrap>} />
        <Route path="/change-password" element={<div>Change password screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireBootstrap', () => {
  it('TC-9: shows a full-page skeleton while loading, never the children (no nav flash)', () => {
    mockedUseBootstrap.mockReturnValue(stub({ isLoading: true }));
    render(
      <RequireBootstrap>
        <nav>Real navigation</nav>
      </RequireBootstrap>,
    );
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('Real navigation')).not.toBeInTheDocument();
  });

  it('renders nothing while unauthorized (RequireAuth performs the redirect)', () => {
    mockedUseBootstrap.mockReturnValue(stub({ isUnauthorized: true }));
    const { container } = render(
      <RequireBootstrap>
        <div>Content</div>
      </RequireBootstrap>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('TC-11: shows a retry-able error page on hard failure, never the raw error', async () => {
    const refetch = vi.fn();
    mockedUseBootstrap.mockReturnValue(stub({ isError: true, refetch }));
    render(
      <RequireBootstrap>
        <div>Content</div>
      </RequireBootstrap>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/at \w+ \(/); // no stack trace fragment
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders children when a background refetch fails but stale data is present', () => {
    mockedUseBootstrap.mockReturnValue(
      stub({
        isError: true,
        user: { id: 1, displayName: 'A', role: 'maker', locale: 'en', timezone: null },
      }),
    );
    render(
      <RequireBootstrap>
        <div>Content</div>
      </RequireBootstrap>,
    );
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  it('TC-3: renders children once bootstrap resolves successfully', () => {
    mockedUseBootstrap.mockReturnValue(stub({}));
    render(
      <RequireBootstrap>
        <div>Dashboard</div>
      </RequireBootstrap>,
    );
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('T-024 TC-7: redirects to /change-password on a confined (PASSWORD_CHANGE_REQUIRED) session, never showing the guarded page', () => {
    mockedUseBootstrap.mockReturnValue(stub({ isError: true, isPasswordChangeRequired: true }));
    renderAtProtectedRoute(<div>Dashboard</div>);
    expect(screen.getByText('Change password screen')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});
