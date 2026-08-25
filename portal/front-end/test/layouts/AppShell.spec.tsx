import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext } from '../../src/auth/useBootstrap';
import { AppShell } from '../../src/layouts/AppShell';
import { THREE_ITEM_NAV, makeBootstrapValue } from './fixtures';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('../../src/lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, create: () => ({ post: mockPost }) } };
});

function renderShell(initialPath = '/dashboard') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <BootstrapContext.Provider value={makeBootstrapValue({ nav: THREE_ITEM_NAV })}>
          <Routes>
            <Route
              path="*"
              element={
                <AppShell>
                  <div>Page content</div>
                </AppShell>
              }
            />
          </Routes>
        </BootstrapContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('AppShell', () => {
  it('renders the sidebar, top bar and page content together', () => {
    mockGet.mockResolvedValue({ data: { data: { count: 0 } } });
    renderShell();

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByText('Reward Portal')).toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it('the mobile drawer opens from the top bar trigger and closes again on navigation', async () => {
    mockGet.mockResolvedValue({ data: { data: { count: 0 } } });
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = await screen.findByRole('dialog', { name: 'Menu' });
    expect(dialog).toBeInTheDocument();

    // The drawer's own nav has a link to /countries; following it should close the drawer.
    const links = screen.getAllByRole('link', { name: 'Countries' });
    await user.click(links[links.length - 1]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
