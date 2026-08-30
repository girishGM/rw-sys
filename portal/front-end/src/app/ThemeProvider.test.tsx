/**
 * T-129 — co-located with `ThemeProvider.tsx` rather than under `test/**` because this task's
 * own broader file scope (see `AGENT-PROTOCOL.md` R9) lists `front-end/src/app/**` but no
 * `front-end/test/app/**` — every other `src/app/*.tsx` file's spec (`ErrorBoundary.spec.tsx`,
 * `providers.spec.tsx`, `router.spec.tsx`) happens to live under `test/auth/**` instead, an
 * older grouping this task's scope does not include. Runs the same way either location would:
 * Vitest's default `include` picks up `*.test.tsx` next to the source exactly like `*.spec.tsx`
 * under `test/`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './ThemeProvider';
import { DEFAULT_UI_THEME, THEME_LABEL, useTheme } from './useTheme';

const { mockGet, mockPatch, mockToastError } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPatch: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('../lib/apiClient', () => ({ api: { get: mockGet, patch: mockPatch } }));
vi.mock('../components/toastActions', () => ({ toast: { error: mockToastError } }));

function suppressExpectedReactErrorLogging() {
  // React logs its own "thrown error" noise to console.error even when the test asserts on
  // the thrown error directly (same helper `test/auth/BootstrapProvider.spec.tsx` uses).
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function Probe() {
  const { theme, options, isSwitching, setTheme } = useTheme();
  return (
    <div>
      <div data-testid="theme">{theme}</div>
      <div data-testid="switching">{String(isSwitching)}</div>
      {options.map((option) => (
        <button key={option} type="button" onClick={() => setTheme(option)}>
          {THEME_LABEL[option]}
        </button>
      ))}
    </div>
  );
}

function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function documentThemeAttribute(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
  mockToastError.mockReset();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeProvider', () => {
  it('TC-1: renders light-blue as the default before the query resolves, for a user who never set one', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'light-blue' } } });
    renderWithClient();

    // The very first paint — before `mockGet`'s promise has had a chance to resolve.
    expect(screen.getByTestId('theme')).toHaveTextContent(DEFAULT_UI_THEME);
    expect(documentThemeAttribute()).toBe('light-blue');

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/users/me/preferences'));
    expect(screen.getByTestId('theme')).toHaveTextContent('light-blue');
    expect(documentThemeAttribute()).toBe('light-blue');
  });

  it('TC-2: applies a saved yellow-black preference the moment the query resolves', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'yellow-black' } } });
    renderWithClient();

    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('yellow-black'));
    expect(documentThemeAttribute()).toBe('yellow-black');
  });

  it('applies a saved red-white preference just as directly', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'red-white' } } });
    renderWithClient();

    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('red-white'));
    expect(documentThemeAttribute()).toBe('red-white');
  });

  it('a network failure degrades to the default theme rather than wedging the shell', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    renderWithClient();

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('light-blue'));
    expect(documentThemeAttribute()).toBe('light-blue');
  });

  it('a response that does not match the shared schema also degrades to the default theme', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'not-a-real-theme' } } });
    renderWithClient();

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('light-blue'));
    expect(documentThemeAttribute()).toBe('light-blue');
  });

  it('TC-3: switching applies the new theme immediately, with no reload', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'light-blue' } } });
    mockPatch.mockResolvedValue({ data: { data: { uiTheme: 'yellow-black' } } });
    const user = userEvent.setup();
    renderWithClient();
    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('light-blue'));

    await user.click(screen.getByRole('button', { name: 'Yellow & Black' }));

    // Applied synchronously, before the PATCH promise below has resolved.
    expect(screen.getByTestId('theme')).toHaveTextContent('yellow-black');
    expect(documentThemeAttribute()).toBe('yellow-black');
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith('/users/me/preferences', { uiTheme: 'yellow-black' }),
    );
  });

  it('TC-5: a failed PATCH rolls back to the previously-applied theme and toasts an error', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'light-blue' } } });
    // A controllable promise, not an immediately-rejecting one: rejecting synchronously would
    // let React Query's `onMutate` (apply) and `onError` (rollback) both settle inside the same
    // `await user.click(...)`, making the optimistic, still-in-flight state unobservable — not
    // because it never happened, but because nothing here would be slow enough to catch it. This
    // is the realistic shape of "a request is in flight" instead.
    let rejectPatch!: (error: unknown) => void;
    mockPatch.mockReturnValue(new Promise((_resolve, reject) => (rejectPatch = reject)));
    const user = userEvent.setup();
    renderWithClient();
    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('light-blue'));

    await user.click(screen.getByRole('button', { name: 'Red & White' }));
    // Applied optimistically first — the switcher never sits idle on the old theme while the
    // request is in flight.
    expect(screen.getByTestId('theme')).toHaveTextContent('red-white');
    expect(documentThemeAttribute()).toBe('red-white');

    rejectPatch({
      isAxiosError: true,
      response: {
        status: 500,
        data: { error: { code: 'INTERNAL_ERROR', message: "Couldn't reach the server." } },
      },
      message: 'Request failed with status code 500',
    });

    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('light-blue'));
    expect(documentThemeAttribute()).toBe('light-blue');
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError.mock.calls[0][0]).toContain("Couldn't reach the server.");
  });

  it('setting the already-active theme is a no-op — no PATCH call, no toast', async () => {
    mockGet.mockResolvedValue({ data: { data: { uiTheme: 'light-blue' } } });
    const user = userEvent.setup();
    renderWithClient();
    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('light-blue'));

    await user.click(screen.getByRole('button', { name: 'Light Blue' }));
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('useTheme() throws a clear error when used outside a <ThemeProvider>', () => {
    const consoleSpy = suppressExpectedReactErrorLogging();
    expect(() => render(<Probe />)).toThrow('useTheme() must be called within a <ThemeProvider>.');
    consoleSpy.mockRestore();
  });
});
