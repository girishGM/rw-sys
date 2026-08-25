/**
 * T-050 — the one place every spec imports `test`/`expect` from. Adds four fixtures on top of
 * `@playwright/test`'s own:
 *
 *  - `state` — the facts `global-setup.ts` produced (`utils/state.ts`). Worker-scoped: it is the
 *    same immutable data (one file, written once, before any worker starts) for every test in the
 *    whole run, so re-reading it per test bought nothing; worker-scoping it is also what lets the
 *    worker-scoped `superAdminApi` fixture below depend on it (a worker-scoped fixture cannot
 *    depend on a test-scoped one).
 *  - `superAdminApi` — the authenticated (login + MFA) `ApiSession` for `super_admin`, **worker**-
 *    scoped: one `ApiSession` built per worker process, but at zero login cost — it replays the
 *    one cookie set `global-setup.ts` already captured (`superAdminSession.ts#superAdminApiSession`
 *    / `apiClient.ts#sessionFromCookies`), rather than performing its own `POST /auth/login`. See
 *    that function's own header for the two real bugs this used to expose and how each was fixed.
 *  - `scenario` — one country → tenant → users → merchant hierarchy (`utils/scenario.ts`). **Not
 *    built per worker at all** — read straight off `state.scenario`, which `global-setup.ts`
 *    builds exactly once for the whole run. See below.
 *  - `isolatedScenario` — a **second** such hierarchy, genuinely separate from `scenario`'s, for
 *    the only two tests that cannot safely share it. See `utils/state.ts`'s own header on
 *    `isolatedScenario` for which tests and why.
 *
 * ### Why `scenario` is a run-wide singleton, not even a worker-scoped one
 *
 * It used to be test-scoped (a fresh scenario, and five fresh real logins — country admin, tenant
 * admin, maker, checker, merchant — per test), on the reasoning that a freshly minted, never-reused
 * email (`utils/ids.ts`) never shares a rate-limit *key* with any other test. That reasoning was
 * correct for the **per-email+IP** limit (`LOGIN_PER_EMAIL_IP_LIMIT`) but missed the **per-IP**
 * limit sitting right next to it in the same table (`LOGIN_PER_IP_LIMIT = 20` per 15 minutes,
 * `security.constants.ts`) — that one is *not* keyed by email at all, so a fresh email on every
 * login buys nothing against it. Confirmed live (T-050, 2026-08-20): running just
 * `negative-journeys.spec.ts` alone (9 scenario-building tests × 5 logins each) produced
 * `RATE_LIMITED` well before the file finished. **Worker-scoping alone was not enough either** —
 * also confirmed live: with 5 workers (Playwright's own local default for this machine) and 9
 * tests in that one file, most workers still built their own scenario, and the run still hit the
 * same ceiling. The full suite is nine spec files; on a limit this task's own files cannot raise
 * (`security.constants.ts` is `back-end/src/common/security/**`, T-012's file scope, not T-050's
 * — AGENT-PROTOCOL R9; no config-driven override for it exists yet in the codebase to opt into for
 * the e2e environment), the only budget that reliably fits under 20 real logins for the *entire*
 * run, independent of however many workers Playwright decides to start, is one shared scenario
 * built once, alongside `super_admin`, before any worker exists at all — see `utils/state.ts`'s
 * own header on `scenario` for the full reasoning.
 *
 * **Sharing one scenario across the whole run is safe only because no test ever performs a
 * session-destroying action (`logout`, `logout-all`, deactivate) on one of `scenario`'s own
 * shared actors.** An earlier version of this file claimed revoking a shared actor's live session
 * was safe too, on the reasoning that it "does not stop the same account logging in again" — true
 * for a *later* test (`fixtures/uiAuth.ts#loggedInContext`'s self-heal handles that), false for a
 * *concurrent* one: `playwright.config.ts`'s `fullyParallel: true` means another spec can be
 * genuinely mid-request on that same, literal session at the exact instant a test elsewhere revokes
 * it. Reproduced live (T-050, 2026-08-21) — see `utils/scenario.ts`'s header, "A fourth, genuinely
 * in-scope bug", for the full account. `session.spec.ts`'s TC-3/TC-4 and
 * `negative-journeys.spec.ts`'s TC-N10 — the only tests that need to revoke a session at all — now
 * mint their own one-off actor (`utils/scenario.ts#createOneOffActor`) instead. Any test that needs
 * a genuinely separate tenant, or to deactivate/delete one of its actors permanently, reads
 * `isolatedScenario` instead — never mutate `scenario` that way either.
 */
import { test as base, expect } from '@playwright/test';
import { ApiSession } from '../utils/apiClient';
import { readState, type E2eState } from '../utils/state';
import type { Scenario } from '../utils/scenario';
import { superAdminApiSession } from './superAdminSession';

interface WorkerFixtures {
  state: E2eState;
  superAdminApi: ApiSession;
  scenario: Scenario;
  isolatedScenario: Scenario;
}

// No test-scoped fixtures remain in this module now that `scenario`/`isolatedScenario` are
// run-wide singletons (see this file's header) — the first type parameter is Playwright's own
// `extend<Test, Worker>` shape.
export const test = base.extend<object, WorkerFixtures>({
  state: [
    async ({}, use) => {
      await use(readState());
    },
    { scope: 'worker' },
  ],

  superAdminApi: [
    async ({ state }, use) => {
      await use(await superAdminApiSession(state));
    },
    { scope: 'worker' },
  ],

  scenario: [
    async ({ state }, use) => {
      await use(state.scenario);
    },
    { scope: 'worker' },
  ],

  isolatedScenario: [
    async ({ state }, use) => {
      await use(state.isolatedScenario);
    },
    { scope: 'worker' },
  ],
});

export { expect };
