import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext } from '../../src/auth/useBootstrap';
import { ThemeProvider } from '../../src/app/ThemeProvider';
import { TopBar } from '../../src/layouts/TopBar';
import { makeBootstrapValue, noop } from './fixtures';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('../../src/lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, create: () => ({ post: mockPost }) } };
});

// T-129 — every GET this component tree can now issue: `NotificationBell`'s unread count and
// `ThemeSwitcher`'s own `ThemeProvider` (`/users/me/preferences`). A blanket
// `mockGet.mockResolvedValue(...)` would answer both calls with the same body, which happens to
// parse fine for the count but fails `ThemeProvider`'s stricter envelope schema — harmless (it
// just falls back to the default theme) but not what this file means to test, so both paths are
// branched explicitly instead.
function mockGetImplementation(path: string) {
  if (path === '/notifications/unread-count') {
    return Promise.resolve({ data: { data: { count: 0 } } });
  }
  if (path === '/users/me/preferences') {
    return Promise.resolve({ data: { data: { uiTheme: 'light-blue' } } });
  }
  return Promise.reject(new Error(`unexpected path ${path}`));
}

function renderTopBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BootstrapContext.Provider value={makeBootstrapValue()}>
          <ThemeProvider>
            <TopBar onOpenMobileNav={noop} />
          </ThemeProvider>
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
  it('renders the mobile-nav trigger, context chip, theme switcher, notification bell and user menu together', () => {
    mockGet.mockImplementation(mockGetImplementation);
    renderTopBar();

    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Light Blue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ada SuperAdmin/ })).toBeInTheDocument();
  });

  it('the mobile-nav trigger calls onOpenMobileNav', async () => {
    mockGet.mockImplementation(mockGetImplementation);
    const onOpen = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BootstrapContext.Provider value={makeBootstrapValue()}>
            <ThemeProvider>
              <TopBar onOpenMobileNav={onOpen} />
            </ThemeProvider>
          </BootstrapContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
