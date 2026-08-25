#!/usr/bin/env node
/**
 * T-021 — cross-platform wrapper around `test-storybook` for `npm run test:a11y`.
 *
 * Why this exists (see the T-021 completion report's "Notes for the reviewer" section for the
 * full investigation, this is the summary): the retry-2 review found `npm run test:a11y` was
 * genuinely flaky (real timeouts, not fabricated) in this project's actual verification
 * environment. Two distinct, independently-confirmed causes, both addressed here or in
 * `jest-playwright.config.cjs`:
 *
 *  1. Headless Chromium throttles a page's timers/idle-callback queue once it decides the page
 *     is "backgrounded" — axe-core schedules its rule checks through that same queue, so this
 *     can stall an otherwise-trivial story for the full test timeout. Fixed via the
 *     `--disable-background-timer-throttling` etc. Chromium launch flags in
 *     `jest-playwright.config.cjs` (proven: an isolated single-file run went from a hard
 *     timeout to a 1.1s pass after adding them).
 *  2. On this project's real verification machine — an ordinary, actively-used macOS
 *     workstation, not a dedicated idle CI runner — macOS's own App Nap / idle power management
 *     can suspend a long-running background process for extended periods (observed: one story
 *     file's test took over 2000s against a 120s configured Jest timeout, meaning the *process
 *     itself*, not just the test, was suspended by the OS). `caffeinate -i` is the standard
 *     macOS mitigation: it holds an "idle sleep assertion" for the lifetime of the wrapped
 *     process. It is macOS-only, so this wrapper only reaches for it on `darwin` and degrades
 *     to a plain, direct `test-storybook` invocation everywhere else (Linux CI, etc.) — the
 *     mandatory DoD gate must not depend on a platform-specific binary being present.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const testStorybookBin = path.join(
  repoRoot,
  '..',
  'node_modules',
  '.bin',
  'test-storybook',
);

const testStorybookArgs = [
  '--url',
  process.env.STORYBOOK_URL ?? 'http://localhost:6006',
  '--maxWorkers=2',
  '--testTimeout=150000',
  ...process.argv.slice(2),
];

const isDarwin = process.platform === 'darwin';
const command = isDarwin ? 'caffeinate' : testStorybookBin;
const args = isDarwin ? ['-i', testStorybookBin, ...testStorybookArgs] : testStorybookArgs;

const child = spawn(command, args, { stdio: 'inherit', cwd: repoRoot });

child.on('error', (err) => {
  // If caffeinate itself is somehow missing on a darwin box, fall back rather than fail the
  // whole gate on a missing convenience wrapper.
  if (isDarwin && err.code === 'ENOENT') {
    console.warn('[test:a11y] caffeinate not found, running test-storybook directly.');
    const fallback = spawn(testStorybookBin, testStorybookArgs, {
      stdio: 'inherit',
      cwd: repoRoot,
    });
    fallback.on('exit', (code) => process.exit(code ?? 1));
    return;
  }
  console.error(err);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
