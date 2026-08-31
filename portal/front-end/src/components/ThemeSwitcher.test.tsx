/**
 * T-129 — co-located with `ThemeSwitcher.tsx` for the same reason `../app/ThemeProvider.test.tsx`
 * is co-located with its own source: this task's file scope lists `front-end/src/components/**`
 * but no `front-end/test/components/theme/**`-style carve-out for it, and Vitest's default
 * `include` already picks up a `*.test.tsx` next to its source the same way it picks up a
 * `*.spec.tsx` under `test/`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../app/ThemeProvider';
import { ThemeSwitcher } from './ThemeSwitcher';

const { mockGet, mockPatch } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPatch: vi.fn() }));

vi.mock('../lib/apiClient', () => ({ api: { get: mockGet, patch: mockPatch } }));
vi.mock('../components/toastActions', () => ({ toast: { error: vi.fn() } }));

function renderSwitcher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ThemeSwitcher />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeSwitcher', () => {
  it("shows the active theme's name on the trigger button, closed by default", async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'yellow-black' } } });
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Yellow & Black' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens a menu listing all 3 themes, each with a swatch, the active one checked', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'light-blue' } } });
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(await screen.findByRole('button', { name: 'Light Blue' }));
    const menu = screen.getByRole('menu', { name: 'Choose a theme' });
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Light Blue'),
        expect.stringContaining('Yellow & Black'),
        expect.stringContaining('Red & White'),
      ]),
    );
    expect(screen.getByRole('menuitem', { name: /Light Blue/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(menu).toBeInTheDocument();
  });

  it('TC-3: selecting a theme applies it immediately and closes the menu, with no reload', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'light-blue' } } });
    mockPatch.mockResolvedValue({ data: { data: { uiTheme: 'red-white' } } });
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(await screen.findByRole('button', { name: 'Light Blue' }));
    await user.click(screen.getByRole('menuitem', { name: /Red & White/ }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Red & White' })).toBeInTheDocument(),
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('red-white');
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith('/users/me/preferences', { uiTheme: 'red-white' }),
    );
  });

  it('closes on Escape', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'light-blue' } } });
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(await screen.findByRole('button', { name: 'Light Blue' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on an outside click', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'light-blue' } } });
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(await screen.findByRole('button', { name: 'Light Blue' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
