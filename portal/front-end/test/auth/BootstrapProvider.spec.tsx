import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapProvider } from '../../src/auth/BootstrapProvider';
import { useBootstrap } from '../../src/auth/useBootstrap';
import { makeAxiosError, makeAxiosErrorWithCode, superAdminBootstrap } from './fixtures';

function suppressExpectedReactErrorLogging() {
  // React logs its own "thrown error" noise to console.error even when the test asserts
  // on the thrown error directly; this keeps that expected noise out of the test output.
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    default: {
      ...actual.default,
      create: () => ({ get: mockGet }),
    },
  };
});

function Probe() {
  const bootstrap = useBootstrap();
  if (bootstrap.isLoading) return <div>loading</div>;
  if (bootstrap.isUnauthorized) return <div>unauthorized</div>;
  if (bootstrap.isPasswordChangeRequired) return <div>password-change-required</div>;
  if (bootstrap.isError) return <div>error</div>;
  return (
    <div>
      <div>ready: {bootstrap.user?.displayName}</div>
      <div>
        can-view-access-control: {String(bootstrap.hasPermission('access_control', 'view'))}
      </div>
      <div>
        can-delete-access-control: {String(bootstrap.hasPermission('access_control', 'delete'))}
      </div>
      <div>
        cannot-anything-on-unknown-entity: {String(bootstrap.hasPermission('nonexistent', 'view'))}
      </div>
    </div>
  );
}

function renderWithClient() {
  // `retryDelay: 0` matters more than `retry: false` here — `useBootstrapQuery` sets its
  // own per-query `retry` predicate (never retrying a 401), which overrides this client
  // default, but not `retryDelay`; without flattening it, the 500 test below would wait
  // through real exponential backoff.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <BootstrapProvider>
        <Probe />
      </BootstrapProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockGet.mockReset();
});

describe('BootstrapProvider', () => {
  it('exposes the fetched bootstrap payload once the query resolves', async () => {
    mockGet.mockResolvedValue({ data: { data: superAdminBootstrap } });
    renderWithClient();
    expect(screen.getByText('loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('ready: Ada SuperAdmin')).toBeInTheDocument());
    expect(screen.getByText('can-view-access-control: true')).toBeInTheDocument();
    expect(screen.getByText('can-delete-access-control: true')).toBeInTheDocument();
    expect(screen.getByText('cannot-anything-on-unknown-entity: false')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/me/bootstrap');
  });

  it('flags a 401 as unauthorized, not a generic error', async () => {
    mockGet.mockRejectedValue(makeAxiosError(401));
    renderWithClient();
    await waitFor(() => expect(screen.getByText('unauthorized')).toBeInTheDocument());
  });

  it('flags a 500 as a generic error, not unauthorized', async () => {
    mockGet.mockRejectedValue(makeAxiosError(500));
    renderWithClient();
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
  });

  it('T-024: flags a 403 PASSWORD_CHANGE_REQUIRED distinctly from a generic error', async () => {
    mockGet.mockRejectedValue(makeAxiosErrorWithCode(403, 'PASSWORD_CHANGE_REQUIRED'));
    renderWithClient();
    await waitFor(() => expect(screen.getByText('password-change-required')).toBeInTheDocument());
  });

  it('T-024: a 403 with a different code is still a generic error', async () => {
    mockGet.mockRejectedValue(makeAxiosErrorWithCode(403, 'PERM_DENIED'));
    renderWithClient();
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
  });

  it('useBootstrap() throws a clear error when used outside a <BootstrapProvider>', () => {
    const consoleSpy = suppressExpectedReactErrorLogging();
    expect(() => render(<Probe />)).toThrow(
      'useBootstrap() must be called within a <BootstrapProvider>.',
    );
    consoleSpy.mockRestore();
  });
});
