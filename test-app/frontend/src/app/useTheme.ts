/**
 * T-005 — the theme context, its hook, and the shared theme constants `ThemeProvider.tsx` and
 * `components/ThemeSwitcher.tsx` both need (ARCHITECTURE.md §5, UI-UX-DESIGN.md).
 *
 * Split out from `ThemeProvider.tsx` the same way `portal/front-end/src/app/useTheme.ts` is
 * split from its own `ThemeProvider.tsx`: `eslint-plugin-react-refresh`'s
 * `only-export-components` rule (this workspace's lint gate runs at `--max-warnings=0`) flags a
 * non-component export — a context object, a hook, a plain constant — sitting in the same file
 * as an exported component. `ThemeProvider.tsx` exports only the `<ThemeProvider>` component;
 * everything else lives here instead.
 */
import { createContext, useContext } from 'react';

/** The 3 themes `tokens.css` defines a `[data-theme="…"]` block for (UI-UX-DESIGN.md's token
 * table) — the only values `setTheme` ever accepts, in the fixed order `ThemeSwitcher` renders
 * its 3 swatches. */
export const THEMES = ['bright', 'midnight', 'celebration'] as const;

export type Theme = (typeof THEMES)[number];

/** No persistence — an explicit product decision (BACKLOG.md "Theme persistence"). Every
 * session starts on Bright, `tokens.css`'s own default (`:root` falls through to the Bright
 * block with no `data-theme` attribute needed at all). */
export const DEFAULT_THEME: Theme = 'bright';

export interface ThemeContextValue {
  readonly theme: Theme;
  setTheme: (next: Theme) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Reads the current theme + switcher from the nearest `<ThemeProvider>`. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme() must be called within a <ThemeProvider>.');
  }
  return ctx;
}
