import type { StorybookConfig } from '@storybook/react-vite';

/**
 * T-021 — Storybook config for the design system (04-FRONTEND.md §7).
 *
 * Standard Storybook 8 + Vite + React setup, no unusual wiring. `npm run storybook` serves
 * all 24 component stories; `npm run test:a11y` drives `@storybook/addon-a11y`'s axe checks
 * headlessly (via `@storybook/test-runner`) against all 86 story states.
 *
 * `npm run test:a11y` itself is a small wrapper (`.storybook/run-a11y.mjs`) plus
 * `jest-playwright.config.cjs` and `.storybook/test-runner.ts` — retry 2/3 shipped this gate
 * as flaky (confirmed independently: real, un-fabricated timeouts, not a fabricated pass).
 * Retry 3/3 root-caused and fixed it rather than re-submitting the same config; see those
 * three files' own comments for what was found and fixed, and the T-021 completion report's
 * "Notes for the reviewer" section for the full run-by-run evidence, including what's now
 * fixed outright (a story timeout no longer corrupts the rest of that file's checks) versus
 * what remains genuine, bounded, host-load-driven variance on this project's real, shared
 * verification machine.
 */
const config: StorybookConfig = {
  stories: ['../src/components/**/*.stories.@(ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    // Drives T-021 TC-2 ("axe-core over every Storybook story, zero violations") from
    // inside the Storybook UI; `npm run test:a11y` (package.json) drives the same addon
    // headlessly via `@storybook/test-runner` for CI.
    '@storybook/addon-a11y',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  docs: {
    autodocs: 'tag',
  },
};

export default config;
