/**
 * T-129 — the topbar theme switcher (13-REWARD-MASTER-VALUE-SOURCES.md §6): a button naming the
 * active theme, opening a popover of the 3 selectable themes with a small colour-swatch preview
 * each. Selecting one applies instantly via `ThemeProvider`'s `setTheme` (no reload — TC-3) and
 * persists it through `PATCH /users/me/preferences` (T-128); a failed save rolls back and toasts
 * (`ThemeProvider.tsx`'s own `onError`, TC-5) rather than anything this component has to handle.
 *
 * Structured identically to `layouts/UserMenu.tsx`'s own popover — button + `useOutsideClick` +
 * `useEscapeKey`, `role="menu"`/`role="menuitem"` — this codebase's one existing precedent for
 * "a small button that opens a list of choices", rather than a second bespoke pattern.
 */
import { useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import type { UiTheme } from '@reward-portal/shared';
import { THEME_LABEL, useTheme } from '../app/useTheme';
import { cx } from './internal/cx';
import { useOutsideClick } from './internal/useOutsideClick';
import { useEscapeKey } from './internal/useEscapeKey';

/**
 * Preview-only colours for each theme's swatch — deliberately literal, not a `tokens.css`
 * variable. A CSS custom property only ever resolves to whichever theme is *currently* active
 * (`[data-theme="…"]`'s own cascade, `styles/tokens.css`), so there is no live token this
 * component could point at to preview the two themes a visitor has not switched to yet. Kept in
 * lock-step, by inspection, with each theme's own `--color-slate-900` / `--color-primary-600` /
 * `--color-primary-50` in `tokens.css` — the one place in `src/components/**` a literal hex
 * value is not a violation of T-021 TC-16's "no hard-coded hex" discipline, which governs a
 * component's own *live* rendering, not a preview swatch of a palette it is not currently
 * rendered under.
 */
const THEME_SWATCH: Readonly<Record<UiTheme, readonly [string, string, string]>> = Object.freeze({
  'light-blue': ['#0f172a', '#4f46e5', '#eef2ff'],
  'yellow-black': ['#14110a', '#8a6508', '#fefce8'],
  'red-white': ['#180f0f', '#b91c1c', '#fef2f2'],
});

function ThemeSwatch({ theme }: { theme: UiTheme }) {
  const [dark, accent, light] = THEME_SWATCH[theme];
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-8 shrink-0 overflow-hidden rounded border border-slate-200"
    >
      <span className="flex-1" style={{ backgroundColor: dark }} />
      <span className="flex-1" style={{ backgroundColor: accent }} />
      <span className="flex-1" style={{ backgroundColor: light }} />
    </span>
  );
}

export function ThemeSwitcher() {
  const { theme, options, isSwitching, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useOutsideClick([containerRef], () => setOpen(false), open);
  useEscapeKey(() => setOpen(false), open);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cx(
          'flex items-center gap-2 rounded-control px-2 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
        )}
      >
        <Palette className="size-4" aria-hidden="true" />
        <span className="hidden lg:inline">{THEME_LABEL[theme]}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Choose a theme"
          className="absolute right-0 top-full z-10 mt-1 w-56 rounded-card border border-slate-200 bg-white p-1 shadow-popover"
        >
          <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Theme
          </p>
          {options.map((option) => {
            const selected = option === theme;
            return (
              <button
                key={option}
                type="button"
                role="menuitem"
                disabled={isSwitching}
                aria-current={selected}
                onClick={() => {
                  setOpen(false);
                  setTheme(option);
                }}
                className={cx(
                  'flex w-full items-center gap-3 rounded-control px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  selected && 'bg-primary-50 text-primary-700',
                )}
              >
                <ThemeSwatch theme={option} />
                <span className="flex-1">{THEME_LABEL[option]}</span>
                {selected && <Check className="size-4" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
