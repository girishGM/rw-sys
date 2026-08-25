/**
 * T-053 verification step 4 — "Lighthouse on the dashboard, Performance >= 90".
 *
 * ## Why this file exists (retry 1/3 — see the T-053 completion report)
 *
 * The first attempt at this task ran Lighthouse exactly once, by hand, purely to cross-check
 * `dashboard-fcp.ts`'s own FCP number (see that file's `measureDashboardFcp` doc comment — the
 * cold-cache-context bug Lighthouse's independent measurement caught). That one-off invocation
 * never captured the **Performance category score** the task file's own Verification step 4
 * actually asks for (0-100, Lighthouse's weighted composite of FCP, LCP, TBT, CLS, Speed Index —
 * not the same number as a single metric), and nothing recorded it. This script is a real,
 * reproducible, checked-in way to do that — against the same authenticated `/dashboard` route,
 * the same production-shaped `docker-compose.yml` stack, under the same emulated conditions
 * (`--preset=desktop --throttling-method=devtools`) `docs/PERFORMANCE.md` already documents using.
 *
 * ## Why an authenticated Lighthouse run needs its own script, not a bare `npx lighthouse <url>`
 *
 * `/dashboard` redirects an unauthenticated request to `/login` (`RequireAuth`, front-end
 * router) — a bare, cookie-less Lighthouse run would audit the *login* page, not the dashboard.
 * Lighthouse's CLI has no login flow of its own, so this script:
 *
 *  1. Reuses `dashboard-fcp.ts`'s own exported login/MFA-enrolment helpers (real login, real
 *     TOTP, real forced password change — see that file's header for the full flow and why it is
 *     not duplicated here) to obtain a genuine, cookie-jar-backed session.
 *  2. Builds a `Cookie` request header from that jar and hands it to Lighthouse via
 *     `--extra-headers`, which Chrome attaches to every request Lighthouse's own audit makes —
 *     including the API calls the Dashboard route fires on load. No CSRF token is needed: every
 *     request Lighthouse's navigation makes to load the page is a `GET` (`CsrfGuard` only guards
 *     state-changing methods, `security.constants.ts#CSRF_EXEMPT_METHODS`).
 *  3. Shells out to the `lighthouse` CLI (already a resolvable dependency via `npx` — see the
 *     completion report for why this is not a new `package.json` dependency) rather than using
 *     Lighthouse's Node API directly, keeping this script dependency-free the same way
 *     `scripts/load-test.js` is.
 *
 * ## Usage
 *
 *   node -r ts-node/register/transpile-only e2e/perf/dashboard-lighthouse.ts \
 *     --base-url http://localhost:8080 \
 *     --email t053.super@example.invalid --password 'Correct-Horse-Battery-T053!' \
 *     --totp-secret <base32 secret printed by a prior enrolment run>
 *
 * Exits non-zero if the Performance score is below 90 (the task file's own budget), so this can
 * be wired into a CI gate later without another script.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type Cookie } from '@playwright/test';
import {
  type Args,
  parseArgs,
  ensureSuperAdmin,
  completeFirstLoginThroughUi,
  loginThroughUi,
  FAST_3G,
  CPU_SLOWDOWN_MULTIPLIER,
} from './dashboard-fcp';

const PERFORMANCE_SCORE_BUDGET = 90;

/** Same shape `scripts/load-test.js#jarFrom`/`csrfTokenFrom` use for a driver that is not a real
 * browser — here the "driver" is the `lighthouse` CLI's own Chrome, and `--extra-headers` is the
 * mechanism, not a cookie jar object, so this renders straight to a `Cookie:` header value. */
function cookieHeaderFrom(cookies: readonly Cookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

interface LighthouseCategoryResult {
  readonly score: number | null;
}

interface LighthouseAuditResult {
  readonly numericValue?: number;
}

interface LighthouseReport {
  readonly categories: {
    readonly performance: LighthouseCategoryResult;
  };
  readonly audits: {
    readonly 'first-contentful-paint'?: LighthouseAuditResult;
    readonly 'largest-contentful-paint'?: LighthouseAuditResult;
    readonly 'total-blocking-time'?: LighthouseAuditResult;
    readonly 'cumulative-layout-shift'?: LighthouseAuditResult;
    readonly 'speed-index'?: LighthouseAuditResult;
  };
}

/**
 * Obtains an authenticated cookie jar the same way `dashboard-fcp.ts#main` does, but returns the
 * cookies instead of going on to measure FCP itself — this script's own job starts where that
 * one's login step ends.
 */
async function authenticate(args: Args): Promise<readonly Cookie[]> {
  await ensureSuperAdmin(args);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (args.totpSecretBase32 !== undefined) {
      await loginThroughUi(page, args);
    } else {
      try {
        const secret = await completeFirstLoginThroughUi(page, args);
        console.log(`[dashboard-lighthouse] enrolled — pass --totp-secret ${secret} to reuse this account.`);
      } catch (enrolError) {
        console.log(
          `[dashboard-lighthouse] enrolment flow did not apply (${String(
            (enrolError as Error).message,
          ).slice(0, 120)}…) — trying a plain login instead (requires --totp-secret).`,
        );
        await loginThroughUi(page, args);
      }
    }
    const cookies = await context.cookies();
    await context.close();
    return cookies;
  } finally {
    await browser.close();
  }
}

/**
 * `--preset=desktop` alone does **not** apply Fast-3G-equivalent throttling — confirmed live,
 * this file's own first real run: an unthrottled desktop-preset audit landed FCP ~195ms/LCP
 * ~220ms, nothing like the ~1.4s `dashboard-fcp.ts`'s CDP-emulated Fast 3G measures for the same
 * route. Passing `FAST_3G`/`CPU_SLOWDOWN_MULTIPLIER` explicitly via Lighthouse's own
 * `--throttling.*` flags (converted from CDP's bytes/second units to Lighthouse's Kbps) makes
 * this a genuine apples-to-apples network condition with TC-15, not a free pass from an
 * unrealistically fast, untthrottled audit.
 */
function runLighthouse(baseUrl: string, cookieHeader: string): LighthouseReport {
  const outputPath = path.join(os.tmpdir(), `t053-lighthouse-${String(Date.now())}.json`);
  const extraHeaders = JSON.stringify({ Cookie: cookieHeader });
  const downloadKbps = (FAST_3G.downloadThroughput * 8) / 1000;
  const uploadKbps = (FAST_3G.uploadThroughput * 8) / 1000;
  console.log(
    `[dashboard-lighthouse] running lighthouse against ${baseUrl}/dashboard ` +
      `(throttled: ${downloadKbps.toFixed(1)} Kbps down / ${uploadKbps.toFixed(1)} Kbps up / ` +
      `${String(FAST_3G.latency)}ms RTT / ${String(CPU_SLOWDOWN_MULTIPLIER)}x CPU slowdown) ...`,
  );
  execFileSync(
    'npx',
    [
      '--yes',
      'lighthouse',
      `${baseUrl}/dashboard`,
      '--only-categories=performance',
      '--preset=desktop',
      '--throttling-method=devtools',
      `--throttling.rttMs=${String(FAST_3G.latency)}`,
      `--throttling.throughputKbps=${String(downloadKbps)}`,
      `--throttling.uploadThroughputKbps=${String(uploadKbps)}`,
      `--throttling.cpuSlowdownMultiplier=${String(CPU_SLOWDOWN_MULTIPLIER)}`,
      `--extra-headers=${extraHeaders}`,
      '--output=json',
      `--output-path=${outputPath}`,
      '--chrome-flags=--headless=new',
      '--quiet',
    ],
    { stdio: 'inherit' },
  );
  const raw = fs.readFileSync(outputPath, 'utf8');
  return JSON.parse(raw) as LighthouseReport;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[dashboard-lighthouse] target ${args.baseUrl}`);

  const cookies = await authenticate(args);
  const cookieHeader = cookieHeaderFrom(cookies);
  const report = runLighthouse(args.baseUrl, cookieHeader);

  const scoreFraction = report.categories.performance.score;
  const score = scoreFraction === null ? null : Math.round(scoreFraction * 100);
  const fcp = report.audits['first-contentful-paint']?.numericValue;
  const lcp = report.audits['largest-contentful-paint']?.numericValue;
  const tbt = report.audits['total-blocking-time']?.numericValue;
  const cls = report.audits['cumulative-layout-shift']?.numericValue;
  const speedIndex = report.audits['speed-index']?.numericValue;

  console.log('\n[T-053 verification step 4] Lighthouse — authenticated /dashboard, desktop preset, devtools throttling:');
  console.log(`  Performance score: ${String(score)} / 100 (budget: >= ${String(PERFORMANCE_SCORE_BUDGET)})`);
  console.log(`  FCP:  ${fcp === undefined ? 'n/a' : `${fcp.toFixed(1)}ms`}`);
  console.log(`  LCP:  ${lcp === undefined ? 'n/a' : `${lcp.toFixed(1)}ms`}`);
  console.log(`  TBT:  ${tbt === undefined ? 'n/a' : `${tbt.toFixed(1)}ms`}`);
  console.log(`  CLS:  ${cls === undefined ? 'n/a' : cls.toFixed(3)}`);
  console.log(`  Speed Index: ${speedIndex === undefined ? 'n/a' : `${speedIndex.toFixed(1)}ms`}`);

  if (score === null || score < PERFORMANCE_SCORE_BUDGET) {
    console.log(`\n✗ Performance score ${String(score)} is BELOW the ${String(PERFORMANCE_SCORE_BUDGET)} budget.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ Performance score ${String(score)} meets the ${String(PERFORMANCE_SCORE_BUDGET)} budget.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
