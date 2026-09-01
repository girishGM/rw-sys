/**
 * T-005 — Tailwind config, wired to `src/styles/tokens.css` (ARCHITECTURE.md §5,
 * UI-UX-DESIGN.md). Every colour/radius/font utility below resolves to a CSS custom property —
 * `tokens.css` is the one place a literal `oklch()`/hex value is allowed to appear. Components
 * consume these via Tailwind utility classes (`bg-accent`, `text-ink-muted`, `rounded-card`),
 * not inline `style` attributes. Supersedes the T-002 scaffold config, which had no tokens yet.
 *
 * Colour keys are named after what each token *is* (`ink`/`ink-muted` for `--text`/
 * `--text-muted`) rather than the CSS var's own name verbatim, so a class reads as
 * `text-ink-muted` instead of the doubled-up `text-text-muted` a literal `text`/`text-muted`
 * key would produce — no change to the underlying token values, purely a Tailwind-side alias.
 */
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        base: 'var(--bg-base)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-solid': 'var(--surface-solid)',
        border: 'var(--border)',
        ink: 'var(--text)',
        'ink-muted': 'var(--text-muted)',
        accent: 'var(--accent)',
        'accent-strong': 'var(--accent-strong)',
        'accent-soft': 'var(--accent-soft)',
        secondary: 'var(--secondary)',
        warn: 'var(--warn)',
        'warn-strong': 'var(--warn-strong)',
        'warn-soft': 'var(--warn-soft)',
      },
      fontFamily: {
        heading: ['Sora', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        body: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card: 'var(--radius-card)',
        chip: 'var(--radius-chip)',
      },
    },
  },
  plugins: [],
} satisfies Config;
