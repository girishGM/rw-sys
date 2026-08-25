import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext } from '../../src/auth/useBootstrap';
import { ContextChip } from '../../src/layouts/ContextChip';
import { makeBootstrapValue } from './fixtures';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../../src/lib/apiClient', () => ({ api: { get: mockGet } }));

function renderChip(scope: Parameters<typeof makeBootstrapValue>[0]['scope']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={makeBootstrapValue({ scope })}>
        <ContextChip />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockGet.mockReset();
});

describe('TC-13: context chip for super_admin', () => {
  it('shows "Global"', () => {
    renderChip({ countryId: null, tenantId: null, merchantId: null });
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('TC-14: context chip for a maker scoped to a country and tenant', () => {
  it('resolves and shows "{country} · {tenant}"', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/countries/1') return Promise.resolve({ data: { data: { name: 'Malaysia' } } });
      if (path === '/tenants/7')
        return Promise.resolve({ data: { data: { name: 'Acme Retail' } } });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    renderChip({ countryId: 1, tenantId: 7, merchantId: null });
    await waitFor(() => expect(screen.getByText('Malaysia · Acme Retail')).toBeInTheDocument());
  });

  it('falls back to a numbered label while the name has not resolved yet', () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    renderChip({ countryId: 1, tenantId: 7, merchantId: null });
    expect(screen.getByText('Country #1 · Tenant #7')).toBeInTheDocument();
  });

  it('falls back to a numbered label if the resolving call fails (route not built yet)', async () => {
    mockGet.mockRejectedValue({ isAxiosError: true, response: { status: 404 }, message: 'nope' });
    renderChip({ countryId: 1, tenantId: 7, merchantId: null });
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.getByText('Country #1 · Tenant #7')).toBeInTheDocument();
  });
});

describe('a country_admin scoped to a country only', () => {
  it('shows just the country label, no dangling separator', async () => {
    mockGet.mockResolvedValue({ data: { data: { name: 'Malaysia' } } });
    renderChip({ countryId: 1, tenantId: null, merchantId: null });
    await waitFor(() => expect(screen.getByText('Malaysia')).toBeInTheDocument());
  });
});
