import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequirePermission } from '../../src/auth/RequirePermission';
import { useBootstrap, type BootstrapContextValue } from '../../src/auth/useBootstrap';

vi.mock('../../src/auth/useBootstrap', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/useBootstrap')>(
    '../../src/auth/useBootstrap',
  );
  return { ...actual, useBootstrap: vi.fn() };
});

const mockedUseBootstrap = vi.mocked(useBootstrap);

function stub(hasPermission: BootstrapContextValue['hasPermission']): BootstrapContextValue {
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
    hasPermission,
    refetch: vi.fn(),
  };
}

/** Stands in for a real page: proves it never mounts, so it never fetches its own data. */
function DataFetchingPage({ onFetch }: { onFetch: () => void }) {
  onFetch();
  return <div>Access Control screen</div>;
}

describe('RequirePermission', () => {
  it('TC-8: renders Forbidden and never mounts the guarded page when permission is missing', () => {
    const onFetch = vi.fn();
    mockedUseBootstrap.mockReturnValue(stub(() => false));
    render(
      <MemoryRouter>
        <RequirePermission entity="access_control" action="view">
          <DataFetchingPage onFetch={onFetch} />
        </RequirePermission>
      </MemoryRouter>,
    );
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByText('Access Control screen')).not.toBeInTheDocument();
    expect(onFetch).not.toHaveBeenCalled();
  });

  it('checks the specific entity/action pair, not just "any permission"', () => {
    const hasPermission = vi.fn(
      (entity: string, action: string) => entity === 'campaign' && action === 'view',
    );
    mockedUseBootstrap.mockReturnValue(stub(hasPermission));
    render(
      <MemoryRouter>
        <RequirePermission entity="access_control" action="view">
          <div>Access Control screen</div>
        </RequirePermission>
      </MemoryRouter>,
    );
    expect(hasPermission).toHaveBeenCalledWith('access_control', 'view');
    expect(screen.queryByText('Access Control screen')).not.toBeInTheDocument();
  });

  it('renders children when the permission is present', () => {
    mockedUseBootstrap.mockReturnValue(stub(() => true));
    render(
      <MemoryRouter>
        <RequirePermission entity="campaign" action="view">
          <div>Campaigns</div>
        </RequirePermission>
      </MemoryRouter>,
    );
    expect(screen.getByText('Campaigns')).toBeInTheDocument();
  });
});
