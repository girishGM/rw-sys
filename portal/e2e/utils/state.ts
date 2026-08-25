/**
 * T-050 — the one piece of state `global-setup.ts` produces and every spec (running in a
 * separate worker process) reads: where the ephemeral stack lives, the one credential a database
 * bootstrap can only ever mint once (`super_admin`), and — as of 2026-08-20 — the one shared
 * `scenario` most specs read from (see `scenario` below for why it lives here now, not built
 * per-worker).
 *
 * Playwright runs `globalSetup` once, in its own process, before any worker starts — so this is
 * written to a file under `.tmp/` (git-ignored, never committed — R4) rather than held in a
 * module-level variable, which would not survive the process boundary. `global-teardown.ts`
 * reads the same file to know what to tear down, and deletes it last.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserCookie } from './apiClient';
import type { Scenario } from './scenario';

export interface E2eState {
  /** The front end's own origin — every `page.goto()` in every spec is relative to this. */
  readonly baseURL: string;
  /** The back end's own origin, `/api/v1` included — used only by API-driven setup helpers. */
  readonly apiBaseURL: string;
  readonly db: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly username: string;
    readonly password: string;
  };
  readonly superAdmin: {
    readonly email: string;
    readonly password: string;
    /** Base32 TOTP seed captured at enrolment (T-055) — kept for the rare caller that genuinely
     * needs a *fresh* login (none, currently — see `cookies` below), not re-derived per worker
     * any more. */
    readonly totpSecretBase32: string;
    /**
     * The one real `super_admin` session's cookies, captured once in `global-setup.ts` right
     * after a **real, headless-browser** login + MFA enrolment (T-060 TC-1, inherited into this
     * task's own acceptance criteria — see `global-setup.ts`'s own header for the full flow).
     * `superAdminSession.ts#superAdminApiSession` replays these into each worker's own
     * `APIRequestContext` (`apiClient.ts#sessionFromCookies`) instead of performing a fresh
     * `POST /auth/login` per worker — T-050 2026-08-20, the same `LOGIN_PER_IP_LIMIT` reasoning
     * `scenario` above is documented against, applied to the one other repeated-per-worker login
     * this suite used to perform. Reuse is about not re-authenticating per worker; it is not a
     * substitute for the one real browser login this run always performs first.
     */
    readonly cookies: readonly BrowserCookie[];
  };
  /**
   * The ephemeral RSA keypair `global-setup.ts` mints for this run and hands the back end as
   * `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` — never committed anywhere (R4), regenerated every run,
   * and gone the moment `.tmp/` is cleaned up. Read by `utils/accessToken.ts#forgeExpiredAccessToken`
   * (the inherited T-058 TC-4 criterion, `T-050-e2e-tests.md`'s own acceptance table) to mint a
   * copy of a real, live session's access token with its `exp` moved into the past — a genuine,
   * independent exercise of `TokenService.verifyAccessToken`'s own expiry check, not a mock of it,
   * because this is the exact key that service verifies against.
   */
  readonly jwtKeys: {
    readonly privatePem: string;
    readonly publicPem: string;
  };
  /** Reference-data ids inserted directly (no REST path creates them — see the completion
   * report's "Notes for the reviewer") that every scenario needs and none can create itself. */
  readonly seedData: {
    readonly ruleSubCategoryId: number;
    readonly activityCategoryId: number;
    readonly activityTypeId: number;
  };
  /**
   * One country → tenant → users → merchant hierarchy, built exactly once for the whole run
   * (`global-setup.ts`, alongside `super_admin`), read from here by every spec that needs one
   * (`fixtures/index.ts`'s `scenario` fixture) rather than each worker minting its own.
   *
   * This is the fix for a real, measured blocker (T-050, 2026-08-20): `LOGIN_PER_IP_LIMIT = 20`
   * per 15 minutes (`security.constants.ts`, T-012's file scope, not this task's — AGENT-PROTOCOL
   * R9, no e2e override exists) is **not** keyed by email, so five fresh logins per scenario times
   * even a handful of workers each building their own exhausted it well before this suite's first
   * run finished — reproduced live, `RATE_LIMITED` on the first test after roughly the 20th real
   * login. One scenario for the entire run reduces that fixed cost to **three** logins, total, no
   * matter how many workers run — `country_admin` and `tenant_admin` (used programmatically inside
   * `buildScenario` itself) plus `maker` (the one delegated role something in this suite still
   * authenticates as through a raw `ApiSession`, not only `realUiLogin`); `checker` and `merchant`
   * are created but never pre-activated, for the same reason (`utils/scenario.ts`'s own header on
   * `createUser`'s `activate` option).
   */
  readonly scenario: Scenario;
  /**
   * A **second** shared hierarchy, for the only two tests that cannot safely use `scenario` above
   * because they need a tenant genuinely isolated from every other test's — `negative-journeys.
   * spec.ts`'s TC-N4 (a cross-tenant campaign id that must belong to a real, different tenant) and
   * TC-N9 (an account safe to permanently deactivate, which `scenario`'s own actors are not — see
   * `fixtures/index.ts`'s header).
   *
   * Built once, exactly like `scenario`, rather than as two more per-test `buildScenario` calls —
   * the original version of this fix (T-050, 2026-08-20) gave TC-N4 and TC-N9 one dedicated
   * scenario *each*, which worked but still cost six real logins (two full country→tenant→maker
   * chains) on top of `scenario`'s own five, and measurably reproduced `RATE_LIMITED` again on a
   * single-file run of just `negative-journeys.spec.ts`. The two tests do not actually need
   * *different* isolated tenants from each other, only a tenant genuinely different from
   * `scenario`'s own and from one another's *targets* — TC-N4 reads this one's `maker` (via a raw
   * API session, to create the cross-tenant campaign), TC-N9 deactivates this one's `checker`
   * (never its `maker` — the two tests would otherwise race on the same account). One shared,
   * isolated scenario, at one-scenario's cost (three logins, once — `scenario`'s own header
   * explains why it is three, not five), covers both.
   */
  readonly isolatedScenario: Scenario;
  readonly pids: {
    readonly backEnd: number;
    readonly frontEnd: number;
  };
  /** Which of `global-setup.ts`'s two database-provisioning strategies produced `db` above —
   * `global-teardown.ts` needs to know which cleanup path to take. `'local'` is the fallback added
   * in T-050's retry 1/3 (`utils/localPostgres.ts`'s header) for a sandbox with no container
   * runtime; CI always gets `'container'`. */
  readonly dbStrategy: 'container' | 'local';
  /** Only set when `dbStrategy` is `'container'` — `null` for the local-Postgres fallback, which
   * has nothing Docker-shaped to stop/remove. */
  readonly containerId: string | null;
}

const STATE_DIR = path.resolve(__dirname, '..', '.tmp');
const STATE_FILE = path.join(STATE_DIR, 'e2e-state.json');

export function writeState(state: E2eState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export function readState(): E2eState {
  if (!existsSync(STATE_FILE)) {
    throw new Error(
      `${STATE_FILE} does not exist. global-setup.ts must run before any spec (Playwright does ` +
        'this automatically for `npm run e2e`; if you are running a spec file directly with the ' +
        'playwright CLI, add --config so globalSetup is picked up).',
    );
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState;
}

export function statePath(): string {
  return STATE_FILE;
}
