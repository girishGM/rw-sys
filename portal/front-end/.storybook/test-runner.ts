import type { TestRunnerConfig } from '@storybook/test-runner';

/**
 * T-021 — `test-storybook` hooks for `npm run test:a11y` (TC-2: axe-core over every story,
 * zero violations).
 *
 * `setup()` runs once per test *file* (see `jest-setup.js` in `@storybook/test-runner`,
 * loaded as a Jest `setupFilesAfterEnv` entry, which is per-file, not once globally) — the
 * right place to enable jest-circus's built-in retry for this specific gate.
 *
 * Why a retry, given `jest-playwright.config.cjs` already fixes the two real root causes of
 * the retry-2 flakiness (background-tab timer/idle-callback throttling, and — the bigger one,
 * found during this retry's investigation — `--disable-gpu` making axe-core's canvas-based
 * `color-contrast` check dramatically slower): this project's actual verification machine is
 * a real, continuously-active, shared macOS workstation, not a dedicated idle CI runner (see
 * that file's comment for the full trace, including measured before/after numbers). Even
 * after both fixes, a small, randomly-distributed fraction of individual story checks can
 * still lose a race against a transient host CPU spike from unrelated processes on that
 * machine and hit the test timeout once. `jest.retryTimes` re-runs *only* that one story's
 * exact same `zero axe violations` assertion — it does not change or loosen what's being
 * checked, so this is absorbing environment noise, not weakening the guard (AGENT-PROTOCOL
 * §7's "never weaken a guard to make a test green" is about the assertion itself, which is
 * untouched here).
 */
const config: TestRunnerConfig = {
  async setup() {
    // eslint-disable-next-line no-undef -- `jest` is injected by jest-circus at runtime here
    jest.retryTimes(2, { logErrorsBeforeRetry: true });
  },
  // Self-heals the specific cascade the retry-2 review reported (a timed-out story leaves the
  // rest of that *file* failing with "ReferenceError: __test is not defined"): a hard timeout
  // destroys the page's JS execution context, which un-defines the `__test` function
  // `@storybook/test-runner` injected via `addScriptTag` at file setup — and since that
  // injection only happens once per file (not before every story), every later story in the
  // same file inherits the broken page. `jest.retryTimes` above helps with independent,
  // one-off flakiness, but retrying alone doesn't fix a corrupted page — confirmed directly:
  // without this hook, all `retryTimes` attempts after a real timeout still failed instantly
  // with the same ReferenceError.
  //
  // Retry-3 review finding (2026-08-18): this hook's first version re-ran `__sbSetupPage`
  // directly against the *same*, already-corrupted `page`. That doesn't work, and the failure
  // this produces is the exact same cascade under a different name: `__sbSetupPage` (see
  // `setupPage` in node_modules/@storybook/test-runner/dist/index.js) unconditionally calls
  // `page.exposeBinding('logToPage', ...)` and `page.exposeBinding('testRunner_...', ...)`
  // before it re-injects the `__test` script. Playwright bindings are **page-scoped and
  // survive navigation** (unlike the `addScriptTag`-injected `__test` function, which does
  // not), so calling `exposeBinding` a second time on the same `Page` object throws
  // `page.exposeBinding: Function "logToPage" has been already registered` — which then fails
  // every remaining story in the file identically, exactly like the original ReferenceError
  // cascade did. `@storybook/test-runner`'s own built-in recovery for the sibling "Execution
  // context was destroyed" case (same file, the `testPrefixer` catch block) never hits this,
  // because it discards the page first: `await jestPlaywright.resetPage()` closes the
  // corrupted page and creates a brand-new one (reassigning the shared `globalThis.page` that
  // every later story in this file reads), *then* calls `__sbSetupPage` against that fresh
  // page, which has no prior bindings to collide with. Mirror that sequence here instead of
  // reusing the stale `page` passed into this hook.
  async preVisit(page) {
    const hasTest = await page
      .evaluate(() => typeof (window as unknown as { __test?: unknown }).__test === 'function')
      .catch(() => false);
    if (!hasTest) {
      const g = globalThis as unknown as {
        __sbSetupPage: (page: unknown, context: unknown) => Promise<void>;
        jestPlaywright: { resetPage: () => Promise<void> };
        page: unknown;
        context: unknown;
      };
      await g.jestPlaywright.resetPage();
      await g.__sbSetupPage(g.page, g.context);
    }
  },
};

export default config;
