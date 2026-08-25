import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { RequireAuth } from '../../src/auth/RequireAuth';
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

function LoginLocationProbe() {
  const location = useLocation();
  return <div data-testid="login-location">{location.pathname + location.search}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginLocationProbe />} />
        <Route
          path="*"
          element={
            <RequireAuth>
              <div>Protected content</div>
            </RequireAuth>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  it('TC-1: redirects to /login with the intended path encoded into next', () => {
    mockedUseBootstrap.mockReturnValue(stub({ isUnauthorized: true }));
    renderAt('/dashboard');
    expect(screen.getByTestId('login-location').textContent).toBe('/login?next=%2Fdashboard');
  });

  it('TC-10: redirects once bootstrap reports a 401, encoding query params too', () => {
    mockedUseBootstrap.mockReturnValue(stub({ isUnauthorized: true }));
    renderAt('/campaigns?status=draft');
    expect(screen.getByTestId('login-location').textContent).toBe(
      `/login?next=${encodeURIComponent('/campaigns?status=draft')}`,
    );
  });

  it('never renders the protected content once unauthorized is known', () => {
    mockedUseBootstrap.mockReturnValue(stub({ isUnauthorized: true }));
    renderAt('/admin/access-control');
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders children while not (yet) known to be unauthorized', () => {
    mockedUseBootstrap.mockReturnValue(stub({ isUnauthorized: false, isLoading: true }));
    renderAt('/dashboard');
    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });
});
