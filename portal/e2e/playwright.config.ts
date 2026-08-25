/**
 * T-050 — Playwright configuration.
 *
 * `globalSetup`/`globalTeardown` own the whole stack (Testcontainers Postgres, migrations, the
 * real back end and front end) — there is no `webServer` entry here, deliberately: `webServer`
 * cannot depend on a database whose host/port are only known after `globalSetup` has already
 * chosen a container port, so this suite manages both server processes itself and hands their
 * base URL to specs through `utils/state.ts` instead (see that file's own header).
 *
 * `retries: 0` even in CI — the Definition of Done says it plainly: *"a flaky E2E suite is worse
 * than none... investigate every flake rather than adding a retry."* A retry that turns a real
 * flake into a green run is exactly the thing this task exists to refuse.
 *
 * ### Two projects, not one — `golden-journey.spec.ts` runs alone, after everything else
 *
 * `golden-journey.spec.ts`'s own steps 12/13 disable the `maker` **role's** "Create Campaign" nav
 * item and `campaign:create` permission via Access Control — `role_nav_configs`/
 * `role_entity_permissions` are keyed by role, not by tenant or account, so this is a global
 * mutation for the window between step 12 and that spec's own `afterAll` restore, not one scoped
 * to the journey's freshly created Maker. Under `fullyParallel: true` with a single project, any
 * other spec that needs `scenario.maker` to still have `campaign:create` and happens to be
 * scheduled on another worker during that window loses the race — reproduced live, T-050
 * 2026-08-21: a full-suite run failed both `golden-journey.spec.ts` itself (its own step 13
 * assertion sees permissions it did not expect mid-flight) and `timezone.spec.ts`'s TC-2 (the
 * wizard's "Next" button never enables, because `campaign:create` was revoked out from under a
 * concurrently-running maker), while the identical spec run in isolation
 * (`--grep "golden journey"`) passed clean. A one-off actor (the fix already applied to
 * `session.spec.ts`/`negative-journeys.spec.ts` for a different race — see `utils/scenario.ts`)
 * does not help here: the mutation is keyed by *role*, so it affects every maker account, not
 * just the shared one. The only structural fix is to guarantee nothing else touches the maker
 * role's nav/permissions while this window is open — Playwright's own `dependencies` field
 * guarantees a project does not start until every project it depends on has fully finished, so
 * `golden-journey` (one spec) runs by itself, after `chromium` (every other spec) has completely
 * finished, in both the default and `--workers=4` configurations alike. This costs some wall
 * time (no overlap between the two projects) but not correctness; it is also the smallest change
 * that removes the race entirely rather than narrowing its window.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // `--workers=4` (verification step 2) overrides this on the CLI; unset locally lets Playwright
  // pick a sensible default for the machine it is running on.
  workers: process.env.CI ? 4 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  globalSetup: require.resolve('./global-setup.ts'),
  globalTeardown: require.resolve('./global-teardown.ts'),
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/golden-journey.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'golden-journey',
      testMatch: '**/golden-journey.spec.ts',
      // See this file's header — must not overlap any spec that touches the maker role's
      // campaign:create permission or nav item.
      dependencies: ['chromium'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  expect: {
    timeout: 10_000,
  },
  timeout: 60_000,
});
