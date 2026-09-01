/**
 * T-005 — the mockup's theme-swatch cluster (UI-UX-DESIGN.md "Header": "a glass theme-swatch
 * cluster (3 small circles, the active theme's circle gets a 2px `--accent` border)"). Calls
 * `useTheme().setTheme` directly — no confirmation, no reload (TC-4).
 *
 * Each swatch previews its *own* theme's accent colour, not the currently-active one, so a
 * visitor can see all 3 options at a glance — a `var(--accent)` reference would only ever
 * resolve to whichever theme is presently applied (`[data-theme="…"]`'s own cascade), so there
 * is no live token this component could point at for the two themes not currently active. The
 * literal values below are kept in lock-step, by inspection, with each theme's own `--accent`
 * in `styles/tokens.css` (same deliberate, documented exception `portal/front-end`'s own
 * `ThemeSwitcher.tsx` takes for exactly this reason).
 */
import { cx } from './internal/cx';
import { THEMES, useTheme, type Theme } from '../app/useTheme';

const THEME_LABEL: Readonly<Record<Theme, string>> = {
  bright: 'Bright',
  midnight: 'Midnight',
  celebration: 'Celebration',
};

const THEME_SWATCH_COLOR: Readonly<Record<Theme, string>> = {
  bright: 'oklch(60% 0.15 165)',
  midnight: 'oklch(78% 0.15 195)',
  celebration: 'oklch(83% 0.16 85)',
};

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Choose a theme"
      className="glass flex items-center gap-1 rounded-full p-1.5"
    >
      {THEMES.map((option) => {
        const active = option === theme;
        return (
          <button
            key={option}
            type="button"
            aria-label={THEME_LABEL[option]}
            aria-pressed={active}
            onClick={() => setTheme(option)}
            // Hit target stays >=44px even though the visible swatch is small
            // (UI-UX-DESIGN.md "Responsive rules": hit targets >=44px on any interactive
            // element).
            className="flex h-11 w-11 items-center justify-center rounded-full"
          >
            {/* The border ring sits a visible gap outside the fill dot rather than flush
                against it — flush would make an active theme's own `--accent` border optically
                disappear into a same-hue fill dot (every swatch's preview colour *is* that
                theme's `--accent`, so the active one's ring and fill always share a hue). */}
            <span
              aria-hidden="true"
              className={cx(
                'flex h-7 w-7 items-center justify-center rounded-full border-2 transition-colors',
                active ? 'border-accent' : 'border-transparent',
              )}
            >
              <span
                className="h-4 w-4 rounded-full"
                style={{ backgroundColor: THEME_SWATCH_COLOR[option] }}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}
