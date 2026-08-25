/**
 * T-021 — Tailwind config, wired to `src/styles/tokens.css` (04-FRONTEND.md §7).
 *
 * Every colour/radius/shadow utility below resolves to a CSS custom property, never a
 * literal value here or in a component — `tokens.css` is the single place a hex value is
 * allowed to appear (T-021 TC-16). Replaces the T-001 `tailwind.config.js` scaffold, which
 * this supersedes.
 */
import type { Config } from 'tailwindcss';

function scale(name: string, steps: number[]): Record<number, string> {
  return Object.fromEntries(steps.map((step) => [step, `var(--color-${name}-${step})`]));
}

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}', './.storybook/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        base: ['var(--font-size-base)', 'var(--line-height-base)'],
      },
      colors: {
        white: 'var(--color-white)',
        slate: scale('slate', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        primary: {
          ...scale('primary', [50, 100, 200, 300, 400, 500, 600, 700, 800]),
          DEFAULT: 'var(--color-primary-600)',
        },
        success: {
          ...scale('success', [50, 100, 200, 500, 600, 700]),
          DEFAULT: 'var(--color-success-600)',
        },
        warning: {
          ...scale('warning', [50, 100, 200, 500, 600, 700]),
          DEFAULT: 'var(--color-warning-500)',
        },
        danger: {
          ...scale('danger', [50, 100, 200, 500, 600, 700]),
          DEFAULT: 'var(--color-danger-600)',
        },
        sky: scale('sky', [50, 100, 200, 500, 600, 700]),
      },
      borderRadius: {
        control: 'var(--radius-control)',
        card: 'var(--radius-card)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        popover: 'var(--shadow-popover)',
      },
    },
  },
  plugins: [],
} satisfies Config;
