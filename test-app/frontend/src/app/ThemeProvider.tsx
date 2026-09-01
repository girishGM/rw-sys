/**
 * T-005 — theme state (ARCHITECTURE.md §5, UI-UX-DESIGN.md). Pure in-memory React Context, no
 * fetch, no persistence (BACKLOG.md "Theme persistence": explicit product decision — resets to
 * `bright` on reload). The one place `data-theme` is ever written to the DOM — every
 * `tokens.css` `[data-theme="…"]` block keys off this exact attribute on `<html>`, so setting it
 * once on the document root re-themes every descendant (`Card`/`ProgressBar`/`Badge`/future
 * pages) with no per-component wiring.
 *
 * Exports only the `<ThemeProvider>` component — the context, the hook and the shared constants
 * live in `./useTheme.ts` instead (see that file's own header for why).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, ThemeContext, type Theme, type ThemeContextValue } from './useTheme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  // The one place `data-theme` is actually written — every render that changes `theme` flows
  // through this single effect rather than each call site touching the DOM itself.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({ theme, setTheme }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
