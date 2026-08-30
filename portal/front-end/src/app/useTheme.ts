/**
 * T-129 — the theme context, its hook, and the shared constants `ThemeProvider.tsx` and
 * `components/ThemeSwitcher.tsx` both need (13-REWARD-MASTER-VALUE-SOURCES.md §6).
 *
 * Split out from `ThemeProvider.tsx` the same way `auth/useBootstrap.ts` is split from
 * `auth/BootstrapProvider.tsx` (see that file's own banner): `eslint-plugin-react-refresh`'s
 * `only-export-components` rule (workspace lint gate runs at `--max-warnings=0`) flags a
 * non-component export — a context object, a hook, a plain constant — sitting in the same file
 * as an exported component. `ThemeProvider.tsx` exports only the `<ThemeProvider>` component;
 * everything else this feature needs to share lives here instead.
 */
import { createContext, useContext } from 'react';
import type { UiTheme } from '@reward-portal/shared';

/** `ck_portal_users_ui_theme` (`T128_001`)'s own default — the column's default, `ThemeProvider`'s
 * fallback for "no preference has ever been saved", and also, not coincidentally,
 * `styles/tokens.css`'s pre-existing base `:root` palette (that file's own T-129 header). */
export const DEFAULT_UI_THEME: UiTheme = 'light-blue';

/** Display copy for the 3 values `UI_THEMES` (`@reward-portal/shared`) allows — the one place
 * this feature spells out human-readable names, so `ThemeSwitcher.tsx` never invents its own. */
export const THEME_LABEL: Readonly<Record<UiTheme, string>> = Object.freeze({
  'light-blue': 'Light Blue',
  'yellow-black': 'Yellow & Black',
  'red-white': 'Red & White',
});

export interface ThemeContextValue {
  readonly theme: UiTheme;
  /** All 3 selectable values, in the fixed order `ThemeSwitcher.tsx` renders them. */
  readonly options: readonly UiTheme[];
  /** `true` while a switch's `PATCH` is in flight — `ThemeSwitcher` disables its options so a
   * second click cannot race the first one's optimistic apply/rollback. */
  readonly isSwitching: boolean;
  setTheme: (next: UiTheme) => void;
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
