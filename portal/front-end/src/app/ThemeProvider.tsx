/**
 * T-129 — loads the caller's persisted UI theme (T-128, `GET /users/me/preferences`) and keeps
 * `<html data-theme="…">` in sync with it, with an optimistic write-through on every switch
 * (`PATCH /users/me/preferences`) that rolls back on failure (13-REWARD-MASTER-VALUE-SOURCES.md
 * §6).
 *
 * Mounted in `ProtectedLayout` (`app/routeStubs.tsx`), inside `RequireBootstrap` and around
 * `AppShell` — the same place that guard chain already establishes "there is a real session"
 * before anything reads it. `GET /users/me/preferences` genuinely needs one (it 401s
 * otherwise), and every screen that can render *before* a session exists (`/login` and friends)
 * already renders the DB column's own default (`light-blue`) for free: `styles/tokens.css`'s
 * base `:root` block *is* that theme, with no `data-theme` attribute needed at all. There is no
 * "flash of the wrong theme" for an unauthenticated visitor to solve.
 *
 * Exports only the `<ThemeProvider>` component — the context, the hook and the shared constants
 * live in `./useTheme.ts` instead, the same split `auth/BootstrapProvider.tsx`/
 * `auth/useBootstrap.ts` already establish for exactly this reason (`only-export-components`,
 * see that pair's own banners).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { UI_THEMES, userPreferencesEnvelopeSchema, type UiTheme } from '@reward-portal/shared';
import { api } from '../lib/apiClient';
import { toApiError } from '../lib/apiError';
import { toast } from '../components/toastActions';
import { DEFAULT_UI_THEME, ThemeContext, type ThemeContextValue } from './useTheme';

const USER_PREFERENCES_QUERY_KEY = ['user-preferences'] as const;

async function fetchUiTheme(): Promise<UiTheme> {
  const response = await api.get<unknown>('/users/me/preferences');
  const parsed = userPreferencesEnvelopeSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error('GET /users/me/preferences response did not match the expected shape.');
  }
  return parsed.data.data.uiTheme;
}

async function patchUiTheme(uiTheme: UiTheme): Promise<void> {
  await api.patch('/users/me/preferences', { uiTheme });
}

/** The one place `data-theme` is ever written — every `tokens.css` theme block (T-129) keys
 * off this exact attribute on the document root. */
function applyThemeAttribute(theme: UiTheme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // TC-1: the very first paint, before the query below has ever resolved, is already the
  // right default — matching `ck_portal_users_ui_theme`'s own `DEFAULT 'light-blue'` and the
  // base `:root` palette this component never has to touch to render it.
  const [theme, setThemeState] = useState<UiTheme>(DEFAULT_UI_THEME);

  const query = useQuery({
    queryKey: USER_PREFERENCES_QUERY_KEY,
    queryFn: fetchUiTheme,
  });

  // TC-2: applies the persisted preference the moment it actually arrives. TC-1's own case
  // (a user who has never set one) also flows through here — the column's default IS
  // `light-blue`, `query.data` resolves to that value for real, and setting it again is a
  // harmless no-op re-render. A definitive failure (network down, session gone — see this
  // file's own banner for why that particular case can't happen here in practice) degrades to
  // the same default rather than leaving whatever the previous render happened to show.
  useEffect(() => {
    if (query.data !== undefined) {
      setThemeState(query.data);
    } else if (query.isError) {
      setThemeState(DEFAULT_UI_THEME);
    }
  }, [query.data, query.isError]);

  // The one place `data-theme` is actually written to the DOM — every render that changes
  // `theme` (the initial default, the query's answer, an optimistic switch, or a rollback)
  // flows through this single effect rather than each of those call sites touching the DOM
  // itself.
  useEffect(() => {
    applyThemeAttribute(theme);
  }, [theme]);

  const mutation = useMutation<void, unknown, UiTheme, { previous: UiTheme }>({
    mutationFn: patchUiTheme,
    onMutate: (next) => {
      const previous = theme;
      // TC-3: applied immediately, optimistically — no reload, no waiting for the network.
      setThemeState(next);
      return { previous };
    },
    onError: (error, _next, context) => {
      // TC-5: a failed PATCH rolls the UI back to whatever was actually applied before this
      // attempt, and says so — never left showing a theme that did not actually persist.
      setThemeState(context?.previous ?? DEFAULT_UI_THEME);
      toast.error(
        `Couldn't save your theme choice — reverted to the previous one. ${toApiError(error).message}`,
      );
    },
  });

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      options: UI_THEMES,
      isSwitching: mutation.isPending,
      setTheme: (next: UiTheme) => {
        if (next === theme || mutation.isPending) return;
        mutation.mutate(next);
      },
    }),
    // `mutation` itself is a fresh object every render (TanStack Query's own contract) —
    // depending on its two read fields directly avoids re-building `value` (and therefore
    // every consumer) on renders where neither actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, mutation.isPending, mutation.mutate],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
