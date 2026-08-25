/**
 * T-021 — jest-playwright-preset config, consumed by `@storybook/test-runner` (the engine
 * behind `npm run test:a11y`).
 *
 * Root cause of the retry-2 flakiness (see AGENT-PROTOCOL review note on T-021, and the
 * T-021 completion report "Notes for the reviewer" section for the full investigation):
 * headless Chromium treats a Playwright page that never gains OS-level focus as a
 * background/occluded tab and heavily throttles its timers and idle-callback queue. axe-core
 * (the engine `@storybook/addon-a11y` uses, and what `__test()` drives per story) schedules
 * its rule checks via `requestIdleCallback`/timer-based batching for performance — under this
 * throttling, that scheduling can stall for tens of seconds on an otherwise-trivial story
 * (confirmed here: unrelated, simple stories like `Card/BodyOnly` or `Input/WithError` hit the
 * exact 60000ms ceiling, not a story-specific issue — see report). This is a well-documented
 * Chromium/Playwright/Puppeteer CI gotcha, not something `--maxWorkers`/`--testTimeout` tuning
 * (already applied in package.json's `test:a11y` script) can fix on its own, because the
 * underlying callback is stalled, not merely slow.
 *
 * The standard fix is to launch Chromium with its background-throttling heuristics disabled,
 * which is what the first four flags below do. Picked up automatically by
 * jest-playwright-preset's `readConfig()` (see node_modules/jest-playwright-preset/lib/utils.js)
 * — no other wiring needed.
 *
 * The remaining flags are the standard, widely-used "headless Chrome in a resource-constrained
 * CI box" hardening set (same ones Lighthouse CI / Puppeteer's own CI docs recommend): they
 * reduce Chromium's own footprint (no GPU process, no /dev/shm size dependency, no background
 * network/extension/sync work) so each of the 24 per-file browser launches this suite does
 * (jest-playwright-preset launches and tears down a fresh browser per story *file*, confirmed
 * in its PlaywrightEnvironment.js) competes less for host CPU/memory — this machine runs real,
 * ongoing developer/agent workloads alongside the test run, not a dedicated, otherwise-idle CI
 * runner, so headroom here matters more than it would in a clean container.
 */
module.exports = {
  launchOptions: {
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      // NOT --disable-gpu: axe-core's color-contrast rule (part of the wcag2aa rule set this
      // project runs, see .storybook/preview.ts) samples rendered pixel colour via canvas,
      // which is markedly slower on software rendering. Measured directly on this project's
      // verification machine (a real macOS box, not a headless Linux CI runner where
      // --disable-gpu is normally the right call): removing this one flag measurably reduced
      // the number of per-story timeouts. Keep it off unless retargeting to Linux CI, where
      // it may be worth reintroducing alongside a GPU allowlist.
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
    ],
  },
};
