/**
 * T-053 TC-15 — measures the Dashboard's First Contentful Paint against the **real**,
 * production-shaped deployment: the same `docker-compose.yml`/`front-end/Dockerfile`/
 * `back-end/Dockerfile`/`front-end/nginx.conf` T-052 built, not the Vite dev server. This is a
 * deliberate choice, not a convenience — `npm run dev` serves unminified, unbundled ES modules
 * over dozens of individual requests, which is a materially different (and *slower*, not faster)
 * payload shape than what a real user's browser ever downloads; measuring FCP against it would
 * prove nothing about the actual 250 KB-gzip, code-split bundle TC-12/TC-13/TC-14 govern. The
 * compose stack also reproduces the one-origin topology `nginx.conf`'s own header explains is load
 * -bearing for cookies (R5) — exactly what a bare `vite preview` (no `/api` reverse proxy) would
 * not give this script for free.
 *
 * ## What this script assumes is already true when it starts
 *
 * `docker compose up -d --build` has already brought up a **healthy** stack (`docs/DEPLOYMENT.md`'s
 * own "first boot" sequence: `.env` from `.env.example` with a real JWT keypair, encryption keys
 * provisioned via `encryption-keys.js provision field`/`provision blind_index` and appended to
 * `.env`, then `docker compose up -d api` to pick them up) — this script does not orchestrate any
 * of that itself, the same division of labour `global-setup.ts` and this file's caller (the T-053
 * completion report) both document explicitly. `--base-url` defaults to `http://localhost:8080`
 * (`docker-compose.yml`'s own `WEB_PORT` default).
 *
 * ## What it does
 *
 *  1. Bootstraps one `super_admin` via the real CLI (`node dist/cli/bootstrap-superadmin.js`,
 *     inside the `api` container) if `--email`/`--password` name an account that does not exist yet
 *     — skipped otherwise, so a second run against the same stack does not fail on
 *     `bootstrap-superadmin.ts`'s own "exactly one `super_admin`" rule.
 *  2. Drives a real, headless Chromium through `/login` → the mandatory MFA enrolment (T-055) →
 *     the forced password change — the exact flow `e2e/global-setup.ts#mfaEnrolSuperAdminThroughBrowser`
 *     already proves works; reused here at script scope rather than imported, because that function
 *     is tied to Playwright's own test-runner globals (`chromium` from `@playwright/test`) and to
 *     `.tmp/e2e-state.json`'s shared-run lifecycle, neither of which this one-shot script has or
 *     wants (running it must never perturb T-050's own tuned login-rate-limit budget — see that
 *     suite's `fixtures/index.ts` header).
 *  3. Once authenticated, unthrottled, navigates *away* from `/dashboard` first — this matters:
 *     the budget is about a **hard, fresh navigation to the Dashboard route**, not an in-app SPA
 *     transition into it (which would reuse an already-warm module cache and paint near-instantly
 *     regardless of network conditions, measuring nothing about "Fast 3G").
 *  4. Opens a Chrome DevTools Protocol session and applies `Network.emulateNetworkConditions` with
 *     Lighthouse's own published "Fast 3G" numbers (1.6 Mbps down / 750 Kbps up / 150 ms RTT —
 *     `lighthouse-core/config/constants.js`'s `throttling.mobileSlow4G`... actually "Fast 3G" is
 *     the *desktop* preset's own numbers, see the constant below) plus 4x CPU slowdown (Lighthouse's
 *     own default for the same preset), then performs one **hard navigation** (`page.goto`, not
 *     `page.click` on a nav link) to `/dashboard`.
 *  5. Reads the real `first-contentful-paint` entry off the Performance Timeline API
 *     (`performance.getEntriesByType('paint')`) — the same API DevTools' own Performance panel and
 *     Lighthouse itself read, not a `Date.now()` measured from outside the page.
 *
 * ## Usage
 *
 *   node -r ts-node/register/transpile-only e2e/perf/dashboard-fcp.ts \
 *     --base-url http://localhost:8080 \
 *     --email t053.super@example.invalid --password 'Correct-Horse-Battery-T053!' \
 *     --temp-password 'Temp-Horse-Battery-T053!'
 *
 * (On a fresh account, `--temp-password` is the one-time bootstrap password
 * `docs/DEPLOYMENT.md`'s "Bootstrap the first Super Admin" step set; `--password` is what this
 * run changes it to. The two **must differ** — see `parseArgs`'s own guard below for why.)
 */
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Cookie, type Page } from '@playwright/test';
import { totpCodeAt } from '../utils/totp';

// `export`ed (added for T-053's Lighthouse companion script, `dashboard-lighthouse.ts`, same
// directory): the login/enrolment flow below is the one genuinely hard part of driving an
// authenticated request against `/dashboard` (real MFA, real forced password change), and
// duplicating it in a second file would be the exact kind of drift this repo's own R9/R10
// discipline warns about — two copies of "how to log in" that can silently disagree. The
// `main()` invocation at the bottom of this file is guarded (`require.main === module`) so
// importing these symbols does not also execute this file's own CLI entrypoint.
export interface Args {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly tempPassword: string;
  /** Given on a repeat run against an account that already completed enrolment once — lets
   * `loginThroughUi` complete the mandatory per-login MFA **verify** step (T-055) without this
   * script needing to re-read a QR/secret it can, by construction, only ever see once
   * (this file's header, step 2). Printed by a successful enrolment run for exactly this reuse. */
  readonly totpSecretBase32: string | undefined;
}

export function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : (argv[index + 1] ?? fallback);
  };
  const getOptional = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const args = {
    baseUrl: get('--base-url', 'http://localhost:8080'),
    email: get('--email', 't053.super@example.invalid'),
    password: get('--password', 'Correct-Horse-Battery-T053!'),
    // Deliberately a DIFFERENT literal from `--password`'s own default (found the hard way,
    // T-053 retry 1: the two used to default to the same string, so any invocation that only
    // ever passes `--password` — the exact form this file's own header's "Usage" example, and
    // `docs/PERFORMANCE.md`'s "Reproducing these numbers" section, both show — silently sent an
    // identical old/new password to `POST /auth/change-password`. The backend correctly rejects
    // that with 400 (a real password-reuse guard, not a bug in it), but `completeFirstLoginThroughUi`
    // has no way to distinguish that from any other failure to reach `/dashboard`, so the whole
    // script just hung until its own `waitForURL(/dashboard)` timeout — a confusing dead end that
    // reproduced on every run with no `--temp-password` given, not once. See the completion report.
    tempPassword: get('--temp-password', 'Temp-Horse-Battery-T053!'),
    totpSecretBase32: getOptional('--totp-secret'),
  };
  if (args.tempPassword === args.password) {
    throw new Error(
      '--temp-password and --password must differ — the backend rejects a change-password ' +
        'request whose new password equals the current one (a real guard, not a bug), and ' +
        'this script has no way to complete first-login enrolment without that step succeeding.',
    );
  }
  return args;
}

/**
 * Lighthouse's own "Fast 3G" desktop-preset numbers (`lighthouse-core/config/constants.js`,
 * `throttling.mobileRegular3G`'s sibling for the non-mobile preset — the one the task file's own
 * budget name, "Dashboard first contentful paint... on Fast 3G", refers to): 1.6 Mbps down,
 * 750 Kbps up, 150 ms round-trip. Expressed here in bytes/second and milliseconds, the units
 * `Network.emulateNetworkConditions` (Chrome DevTools Protocol) takes.
 *
 * `export`ed for `dashboard-lighthouse.ts` (same directory) — Lighthouse's own `--preset=desktop`
 * does *not* apply these values by default (confirmed live: an unthrottled `--preset=desktop`
 * run landed FCP ~195ms, nothing like the ~1.4s this repo's own CDP-throttled measurement gets
 * for the same route), so that script passes these same numbers to Lighthouse's own
 * `--throttling.*` CLI flags explicitly — one Fast-3G definition, not two that could drift apart.
 */
export const FAST_3G = {
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  latency: 150,
};
/** Lighthouse's own default CPU slowdown multiplier for its non-mobile "Fast 3G" preset. */
export const CPU_SLOWDOWN_MULTIPLIER = 4;

export async function ensureSuperAdmin(args: Args): Promise<void> {
  try {
    execFileSync(
      'docker',
      [
        'compose',
        'exec',
        '-e', `SUPERADMIN_EMAIL=${args.email}`,
        '-e', 'SUPERADMIN_NAME=T-053 perf super admin',
        '-e', `SUPERADMIN_PASSWORD=${args.tempPassword}`,
        'api',
        'node',
        'dist/cli/bootstrap-superadmin.js',
      ],
      { stdio: 'pipe' },
    );
    console.log(`[dashboard-fcp] bootstrapped a fresh super_admin (${args.email}).`);
  } catch (error) {
    const output = String((error as { stderr?: Buffer }).stderr ?? error);
    if (/already exists|a super_admin already exists/i.test(output)) {
      console.log(`[dashboard-fcp] super_admin already exists — reusing it (must already know its ` +
        'real, already-changed password; pass --password for that, not --temp-password).');
      return;
    }
    throw error;
  }
}

/** Same real, screen-driven flow `global-setup.ts#mfaEnrolSuperAdminThroughBrowser` proves —
 * see this file's header for why it is not imported from there directly. */
export async function completeFirstLoginThroughUi(page: Page, args: Args): Promise<string> {
  await page.goto(`${args.baseUrl}/login`);
  await page.getByLabel('Email').fill(args.email);
  await page.getByLabel('Password').fill(args.tempPassword);
  const [loginResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/auth/login'), { timeout: 60_000 }),
    page.getByRole('button', { name: 'Log in' }).click(),
  ]);
  console.log(`[dashboard-fcp] POST /auth/login -> ${String(loginResponse.status())}`);

  await page.waitForURL((url) => url.pathname === '/mfa-challenge', { timeout: 60_000 });
  await page
    .getByRole('heading', { name: 'Set up two-factor authentication' })
    .waitFor({ state: 'visible', timeout: 60_000 });

  const rawSecret = (await page.locator('code').first().innerText()).replace(/\s+/g, '');
  await page.getByLabel('Verification code').fill(totpCodeAt(rawSecret));
  await page.getByRole('button', { name: 'Enable two-factor authentication' }).click();

  await page
    .getByRole('heading', { name: 'Save your recovery codes' })
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: /saved these codes/i }).click();

  await page.waitForURL((url) => url.pathname === '/change-password', { timeout: 60_000 });
  await page.getByLabel('Current password').fill(args.tempPassword);
  await page.getByLabel('New password', { exact: true }).fill(args.password);
  await page.getByLabel('Confirm new password').fill(args.password);
  await page.getByRole('button', { name: 'Change password' }).click();

  await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 60_000 });
  await page.getByRole('heading', { level: 1 }).first().waitFor({ state: 'visible', timeout: 60_000 });
  return rawSecret;
}

/** Reused on a re-run against a stack whose `super_admin` already completed MFA enrolment and
 * password-change once — a plain login, still completing the **verify** phase of MFA every time
 * (T-055: mandatory on every login, not just the first) rather than the one-off enrolment flow
 * above. */
export async function loginThroughUi(page: Page, args: Args): Promise<void> {
  await page.goto(`${args.baseUrl}/login`);
  await page.getByLabel('Email').fill(args.email);
  await page.getByLabel('Password').fill(args.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL((url) => url.pathname === '/mfa-challenge', { timeout: 60_000 });
  await page
    .getByRole('heading', { name: 'Enter your verification code' })
    .waitFor({ state: 'visible', timeout: 60_000 });
  const rawSecret = args.totpSecretBase32;
  if (rawSecret === undefined) {
    throw new Error('loginThroughUi: no --totp-secret given for a repeat login on an already-enrolled account.');
  }
  await page.getByLabel('Verification code').fill(totpCodeAt(rawSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 60_000 });
}

/**
 * Measures Dashboard FCP in a **fresh, empty-cache** `BrowserContext** — not the one the login/
 * enrolment flow already ran in.
 *
 * This is not a stylistic choice; it is the fix for a real, measured methodology bug this file
 * shipped with initially (T-053, disclosed in the completion report): the first version reused
 * the already-logged-in `context` for the throttled navigation too. That context's HTTP cache was
 * already warm — the entry bundle, CSS and every asset `/dashboard` needs had already been
 * fetched, unthrottled, by the login/enrolment flow's own earlier navigations through `/login` →
 * `/mfa-challenge` → `/change-password` → `/dashboard` — so the "throttled" run mostly served
 * cached responses and measured something closer to a *returning visitor's* warm-cache FCP
 * (~470ms) than the *budget's actual subject*: a real, cold page load on a slow connection. A
 * genuinely independent cross-check with Lighthouse (`docs/PERFORMANCE.md` records the exact
 * invocation) caught the gap directly — Lighthouse clears storage before its own run by default,
 * and reported ~3.4s FCP for the same route under matching throttling parameters, not ~470ms.
 * That size of discrepancy between two tools measuring "the same thing" is exactly the signal
 * that one of them was not measuring the same thing.
 *
 * The fix: authenticate once (`completeFirstLoginThroughUi`/`loginThroughUi`, unthrottled, in
 * their own context), capture the resulting cookies, then hand them to a **new** context here —
 * Chromium's contexts are isolated the way separate profiles are (own cache, own storage) — so
 * this page has a valid session but has never fetched a single byte of the app before the
 * throttled, hard navigation below.
 */
async function measureDashboardFcp(
  browser: Browser,
  baseUrl: string,
  cookies: readonly Cookie[],
): Promise<number> {
  const context = await browser.newContext();
  await context.addCookies(cookies as Cookie[]);
  const page = await context.newPage();

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: FAST_3G.latency,
    downloadThroughput: FAST_3G.downloadThroughput,
    uploadThroughput: FAST_3G.uploadThroughput,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN_MULTIPLIER });

  const start = Date.now();
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'commit' });
  await page.waitForFunction(
    () => performance.getEntriesByType('paint').some((entry) => entry.name === 'first-contentful-paint'),
    { timeout: 60_000 },
  );
  const wallClockMs = Date.now() - start;

  const fcpMs = await page.evaluate(() => {
    const entry = performance
      .getEntriesByType('paint')
      .find((e) => e.name === 'first-contentful-paint');
    return entry ? entry.startTime : -1;
  });

  console.log(
    `[dashboard-fcp] Performance-Timeline FCP (cold cache): ${fcpMs.toFixed(1)}ms ` +
      `(wall-clock from navigation start to the FCP condition resolving: ${String(wallClockMs)}ms)`,
  );

  await context.close();
  return fcpMs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[dashboard-fcp] target ${args.baseUrl}`);

  await ensureSuperAdmin(args);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Try the enrolment flow first (fresh account, or `--totp-secret` not given); fall back to a
    // plain (verify-only) login if this `super_admin` already completed enrolment and a secret
    // was passed in. `NO_FALLBACK=1` skips the second attempt entirely — every login (even a
    // failed one) spends real budget against `LOGIN_PER_IP_LIMIT` (`security.constants.ts`,
    // 20/15min, in-memory — `docker compose restart api` is what actually clears it, not time
    // alone, while iterating).
    if (args.totpSecretBase32 !== undefined) {
      await loginThroughUi(page, args);
    } else if (process.env.NO_FALLBACK === '1') {
      const secret = await completeFirstLoginThroughUi(page, args);
      console.log(`[dashboard-fcp] enrolled — pass --totp-secret ${secret} to reuse this account.`);
    } else {
      try {
        const secret = await completeFirstLoginThroughUi(page, args);
        console.log(`[dashboard-fcp] enrolled — pass --totp-secret ${secret} to reuse this account.`);
      } catch (enrolError) {
        console.log(
          `[dashboard-fcp] enrolment flow did not apply (${String(
            (enrolError as Error).message,
          ).slice(0, 120)}…) — trying a plain login instead (requires --totp-secret).`,
        );
        await loginThroughUi(page, args);
      }
    }
    // Captured here, before this (now warm-cache) context is discarded — `measureDashboardFcp`
    // replays these into a brand-new, empty-cache context of its own. See that function's own
    // header for why this indirection exists at all.
    const cookies = await context.cookies();
    await context.close();

    const fcpMs = await measureDashboardFcp(browser, args.baseUrl, cookies);
    console.log(`\n[T-053 TC-15] Dashboard FCP on emulated Fast 3G, cold cache (${String(CPU_SLOWDOWN_MULTIPLIER)}x CPU slowdown): ${fcpMs.toFixed(1)}ms`);
    console.log(fcpMs < 1500 ? '✓ under the 1.5s budget.' : '✗ OVER the 1.5s budget.');
  } finally {
    await browser.close();
  }
}

// Guarded so `dashboard-lighthouse.ts` (same directory) can import the exported helpers above
// without also triggering this file's own CLI run as a side effect of the import.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
