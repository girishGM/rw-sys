import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext } from '../../src/auth/useBootstrap';
import { TopBar } from '../../src/layouts/TopBar';
import { makeBootstrapValue, noop } from './fixtures';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('../../src/lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, create: () => ({ post: mockPost }) } };
});

function renderTopBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BootstrapContext.Provider value={makeBootstrapValue()}>
          <TopBar onOpenMobileNav={noop} />
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

describe('TopBar', () => {
  it('renders the mobile-nav trigger, context chip, notification bell and user menu together', () => {
    mockGet.mockResolvedValue({ data: { data: { count: 0 } } });
    renderTopBar();

    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ada SuperAdmin/ })).toBeInTheDocument();
  });

  it('the mobile-nav trigger calls onOpenMobileNav', async () => {
    mockGet.mockResolvedValue({ data: { data: { count: 0 } } });
    const onOpen = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BootstrapContext.Provider value={makeBootstrapValue()}>
            <TopBar onOpenMobileNav={onOpen} />
          </BootstrapContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
