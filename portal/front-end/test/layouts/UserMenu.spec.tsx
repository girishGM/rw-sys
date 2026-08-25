import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext } from '../../src/auth/useBootstrap';
import { UserMenu } from '../../src/layouts/UserMenu';
import { makeBootstrapValue } from './fixtures';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, create: () => ({ post: mockPost }) } };
});

function renderMenu() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BootstrapContext.Provider
          value={makeBootstrapValue({
            user: { id: 9, displayName: 'Mo Maker', role: 'maker', locale: 'en', timezone: null },
          })}
        >
          <UserMenu />
        </BootstrapContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockPost.mockReset();
});

describe('TC-20: the user menu', () => {
  it('shows display name, role badge, and a logout action once opened', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /Mo Maker/ }));

    const menu = screen.getByRole('menu', { name: 'Mo Maker account menu' });
    expect(menu).toBeInTheDocument();
    expect(screen.getByText('Maker')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: /Mo Maker/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on an outside click', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: /Mo Maker/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('mousedown on "Log out" calls POST /auth/logout and clears the cache', async () => {
    mockPost.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: /Mo Maker/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(mockPost).toHaveBeenCalledWith('/auth/logout', null, expect.anything());
  });

  it('renders nothing while there is no user yet (bootstrap still resolving)', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BootstrapContext.Provider value={makeBootstrapValue({ user: undefined })}>
            <UserMenu />
          </BootstrapContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to "?" initials for a display name with no letters to take (edge case)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BootstrapContext.Provider
            value={makeBootstrapValue({
              user: { id: 1, displayName: '   ', role: 'maker', locale: 'en', timezone: null },
            })}
          >
            <UserMenu />
          </BootstrapContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});
