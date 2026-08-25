#!/usr/bin/env node
/**
 * T-053 — a dependency-free load-test driver for the portal API.
 *
 * ## Why not k6 or autocannon
 *
 * Both are named in the task file as acceptable tools, but neither is an existing dependency of
 * this repo, and `back-end/package.json`/`front-end/package.json` are genuinely not in this
 * task's file scope (see `project-plan/tasks/T-053-performance.md`'s own "Files owned" list, which
 * names only `scripts/load-test.js`, `back-end/test/performance/**`, `front-end/.size-limit.json`
 * and `docs/PERFORMANCE.md`) — adding either as a real dependency would need one of those two
 * files. (Root `portal/package.json` is a different story: `agent-qa`'s scope in
 * `project-plan/scripts/orchestrator.js` has carried a standing, narrow `Edit(package.json)` grant
 * since T-057 — used there to reorder the `workspaces` array — and this retry of T-053 uses that
 * same pre-existing grant to wire the three `npm run test:perf`/`size-limit`/`load-test` scripts
 * the task file's own Verification steps require; see the completion report. That does not change
 * the reasoning below, which is about *dependencies*, not *scripts*: no new package needed
 * installing either way.) `e2e/package.json` set the precedent for the same-direction problem
 * T-050 had (that file's own header: "e2e is a standalone npm project... T-050's file scope is
 * e2e/** only, and the root workspaces list is another task's owned file"). This script follows
 * the same discipline: it needs no `npm install` at all, built entirely on Node's own
 * `http`/`https` modules, so no *dependency* anywhere in the repo has to change for it to run.
 *
 * ## What it does
 *
 * Drives a configurable number of requests per second at a running instance of the API (real,
 * already-booted — this script does not start one), for a configurable duration, optionally
 * followed by a spike to a higher rate, and reports p50/p95/p99 latency and the error rate per
 * named request type. A "mixed workload" (the default) sends bootstrap, list and login requests
 * in realistic proportions rather than hammering one endpoint.
 *
 * ## Usage
 *
 *   node scripts/load-test.js \
 *     --base-url http://localhost:3000/api/v1 \
 *     --credentials ./actors.json \
 *     --rps 50 --duration 300 \
 *     --spike-rps 200 --spike-duration 30
 *
 * (`--email maker@example.invalid --password '...'` also works, for a quick single-actor smoke
 * run — see "Why more than one actor" below for why `--credentials` is what a real `--rps 50`
 * sustained-phase number needs.)
 *
 * `--email`/`--password` (or `--credentials`, see below) log in once at the start (real login,
 * real cookies — the same auth this budget is measuring) and reuse the session for every
 * authenticated request. Login itself is *not* repeated per request (that would re-measure
 * Argon2's deliberate cost on every single request and dominate the whole run for no reason —
 * see `submit-and-login-latency.e2e-spec.ts` for the dedicated login-latency measurement).
 *
 * Every flag has a default so `node scripts/load-test.js` alone runs a short, safe smoke run
 * against `http://localhost:3000/api/v1` with no credentials (unauthenticated routes only).
 *
 * ## Why more than one actor (`--credentials`, not just `--email`/`--password`)
 *
 * T-012's `AUTHENTICATED_API_LIMIT` (`security.constants.ts`) is 300 requests/user/minute —
 * 5 rps, per session, forever, by design (02-SECURITY.md §8). A single `--email`/`--password`
 * actor asked to sustain 50 rps cannot honestly do it: confirmed live, T-053's own first real run
 * against a booted stack, one actor at 50 rps for 5 minutes — **86% of requests 429'd**
 * (`bootstrap`: 5,550/6,429), not because the API was slow or the database was struggling, but
 * because that one session's own per-user ceiling is 10x lower than the rate being asked of it.
 * A 429 short-circuits before touching the database, so the run's own p50/p95 numbers were
 * *better* than reality would be under genuine load — the wrong kind of "passing".
 *
 * `--credentials <path-to-json>` (`[{"email":"...","password":"..."}, ...]`) logs in every actor
 * once, sequentially (never a burst — that would trip `LOGIN_PER_IP_LIMIT` instead), and
 * round-robins a *fresh actor per authenticated request* (`runPhase`'s own `actorCursor`, not per
 * request-type) — the same shape a real 50 rps of *distinct users* has. `docs/PERFORMANCE.md`
 * documents how many actors this repo's own measured run used and why.
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// Mirrors `back-end/src/common/security/security.constants.ts#CSRF_HEADER_NAME` — a literal,
// not an import: this script is deliberately dependency-free and standalone from the back-end
// build (this file's own header, "Why not k6 or autocannon"), so it cannot `require` a TS source
// file. `x-csrf-token` is public knowledge (it is sent in a request header by every real
// browser session every day, per `apiClient.ts`), not a secret this duplication risks exposing.
const CSRF_HEADER_NAME = 'x-csrf-token';

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://localhost:3000/api/v1',
    email: null,
    password: null,
    credentialsPath: null,
    rps: 10,
    durationSeconds: 30,
    spikeRps: null,
    spikeDurationSeconds: 15,
    workload: 'mixed',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--base-url':
        args.baseUrl = value;
        i += 1;
        break;
      case '--email':
        args.email = value;
        i += 1;
        break;
      case '--password':
        args.password = value;
        i += 1;
        break;
      case '--credentials':
        args.credentialsPath = value;
        i += 1;
        break;
      case '--rps':
        args.rps = Number(value);
        i += 1;
        break;
      case '--duration':
        args.durationSeconds = Number(value);
        i += 1;
        break;
      case '--spike-rps':
        args.spikeRps = Number(value);
        i += 1;
        break;
      case '--spike-duration':
        args.spikeDurationSeconds = Number(value);
        i += 1;
        break;
      case '--workload':
        args.workload = value;
        i += 1;
        break;
      case '--help':
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/load-test.js [options]

  --base-url <url>        API base URL (default http://localhost:3000/api/v1)
  --email <email>         Log in as this one user before the run (optional)
  --password <password>   Password for --email
  --credentials <path>    JSON file: [{"email":"...","password":"..."}, ...] — many actors,
                           round-robined per request. Use this for any real --rps run above
                           ~5 (T-012's AUTHENTICATED_API_LIMIT is 300 req/user/minute = 5 rps/user
                           — a single --email/--password actor above that rate mostly measures
                           429s, not the API). Takes priority over --email/--password if both given.
  --rps <n>                Sustained requests/second (default 10)
  --duration <seconds>     Sustained-phase duration (default 30)
  --spike-rps <n>          If set, run a second phase at this rate
  --spike-duration <sec>   Spike-phase duration (default 15)
  --workload <name>        "mixed" (default) or "bootstrap-only"
`);
}

/**
 * Joins `baseUrl` (which may itself carry a path, e.g. `http://host:port/api/v1`) with a
 * request `path` (e.g. `/auth/login`) the way a human reading `--base-url`'s own usage example
 * expects — **not** what `new URL(path, baseUrl)` does on its own. Per the WHATWG URL spec, a
 * second argument (`path`) starting with `/` is resolved against the base's *origin*, discarding
 * the base's own path entirely: `new URL('/auth/login', 'http://host/api/v1')` is
 * `http://host/auth/login`, silently dropping `/api/v1` — confirmed live (T-053, this script's
 * own first real run against a booted stack: every request 404/405'd against nginx's SPA
 * fallback route instead of the API, because the whole point of `--base-url .../api/v1` had
 * been thrown away). Stripping `path`'s leading slash and ensuring `baseUrl` ends in one before
 * handing both to `new URL` makes it a genuine append instead.
 */
function joinUrl(baseUrl, path) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const relative = path.startsWith('/') ? path.slice(1) : path;
  return new URL(relative, base);
}

/** One request, timed, tolerant of any status code (a 429 or a 503 is a *result*, not a crash). */
function timedRequest(baseUrl, path, options) {
  return new Promise((resolve) => {
    const url = joinUrl(baseUrl, path);
    const client = url.protocol === 'https:' ? https : http;
    const start = process.hrtime.bigint();
    const req = client.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        // Body is drained but discarded — this is a load driver, not a correctness suite (the
        // e2e specs under `back-end/test/performance/**` already assert response *shape*).
        res.on('data', () => undefined);
        res.on('end', () => {
          const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
          resolve({ status: res.statusCode, elapsedMs, headers: res.headers });
        });
      },
    );
    req.on('error', () => {
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ status: 0, elapsedMs, headers: {} });
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** `Set-Cookie` header values, joined the way a browser's own cookie jar would send them back. */
function jarFrom(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  return setCookieHeaders
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

/**
 * Reads the `rs_csrf` cookie's value out of a jar string built by {@link jarFrom} — needed to
 * send as the `X-CSRF-Token` header on any state-changing (non-GET/HEAD/OPTIONS) request
 * (`CsrfGuard`/`CSRF_EXEMPT_METHODS`, `security.constants.ts`). A raw `Cookie` header alone is
 * not enough for a POST here: this driver is not a browser, so nothing attaches the header for
 * it automatically the way `apiClient.ts` does client-side.
 */
function csrfTokenFrom(jar) {
  const match = jar.split(';').map((s) => s.trim()).find((pair) => pair.startsWith('rs_csrf='));
  return match ? match.slice('rs_csrf='.length) : null;
}

async function login(baseUrl, email, password) {
  const response = await timedRequest(baseUrl, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) {
    throw new Error(`login failed with status ${String(response.status)} — check --email/--password`);
  }
  return jarFrom(response.headers['set-cookie']);
}

/**
 * `POST /auth/refresh` — rotates `cookie`'s session (access + refresh + CSRF, all three always
 * reissued together, `auth.controller.ts#setSessionCookies`) and returns the new jar. Used to
 * keep long-running phases (the 30-minute soak, TC-19) authenticated past the access token's own
 * 15-minute lifetime (`ACCESS_COOKIE`'s `Max-Age=900`, confirmed live) — without this, every
 * actor's session silently goes stale partway through any run longer than ~900s, and every
 * request after that point falls through to the *unauthenticated* per-IP bucket
 * (`UNAUTHENTICATED_API_LIMIT = 60/min`, shared across every actor since they all share this
 * driver's one IP) instead of each actor's own generous 300/min — confirmed live, T-053's own
 * first real 30-minute soak: a clean 0% 429 rate for the first ~900s, then a wall of 429s for
 * the rest, averaging ~49% overall. Not a server capacity problem; a test-driver one, now fixed.
 */
async function refresh(baseUrl, cookie) {
  const csrfToken = csrfTokenFrom(cookie);
  const headers = { Cookie: cookie };
  // A missing token is a real, reportable failure (`response.status !== 200` below catches it as
  // a 403, same as the guard would) rather than silently omitting the header — this mirrors
  // `apiClient.ts`'s own requirement that every state-changing request carries one.
  if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;
  const response = await timedRequest(baseUrl, '/auth/refresh', {
    method: 'POST',
    headers,
  });
  if (response.status !== 200) {
    throw new Error(`refresh failed with status ${String(response.status)}`);
  }
  return jarFrom(response.headers['set-cookie']);
}

/**
 * Refreshes every cookie in `cookies` **in place** (mutates the array `runPhase` is concurrently
 * reading from) every `intervalMs`, until `stop()` is called. Sequential per round, same reason
 * `loginAll` is sequential — a burst of simultaneous `/auth/refresh` calls is real traffic against
 * `refresh_per_session`'s own throttle for no benefit, and this driver has the whole interval to
 * spread them across.
 */
function startCookieRefresher(baseUrl, cookies, intervalMs) {
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      for (let i = 0; i < cookies.length && !stopped; i += 1) {
        try {
          cookies[i] = await refresh(baseUrl, cookies[i]);
        } catch (error) {
          console.log(`⚠ actor ${String(i)} session refresh failed: ${String(error.message || error)}`);
        }
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Logs in every `{ email, password }` pair in `credentials`, **sequentially** (never
 * `Promise.all` — a burst of simultaneous real logins is exactly the traffic
 * `LOGIN_PER_IP_LIMIT`/`LOGIN_PER_EMAIL_IP_LIMIT` exist to catch, and this driver's own job is to
 * generate *sustained-phase* traffic, not trip the login guard before that phase even starts).
 * Returns one cookie jar per actor, in the same order.
 */
async function loginAll(baseUrl, credentials) {
  const cookies = [];
  for (const { email, password } of credentials) {
    cookies.push(await login(baseUrl, email, password));
  }
  return cookies;
}

/**
 * Every distinct request this driver can issue, weighted for the default "mixed" workload.
 * `authenticated: true` marks a spec whose `Cookie` header `runPhase` fills in per-send from its
 * own actor round-robin — see this file's header, "Why more than one actor", for why a
 * single-cookie run cannot honestly produce a *sustained* 50 rps number: T-012's
 * `AUTHENTICATED_API_LIMIT` (300 req/user/minute = 5 rps/user, `security.constants.ts`) throttles
 * one session long before 50 rps of real traffic from *many* concurrent users ever would, and a
 * 429 short-circuits before touching the database — cheap and fast, which would make a
 * single-actor "50 rps" run's own p50/p95 numbers look *better* than reality, for the wrong
 * reason.
 */
function buildWorkload(name) {
  const bootstrap = { name: 'bootstrap', path: '/me/bootstrap', method: 'GET', authenticated: true };
  const campaigns = {
    name: 'campaigns_list',
    path: '/campaigns?page=1&pageSize=20',
    method: 'GET',
    authenticated: true,
  };
  const users = {
    name: 'users_list',
    path: '/users?page=1&pageSize=20',
    method: 'GET',
    authenticated: true,
  };
  const health = { name: 'health', path: '/health', method: 'GET', authenticated: false };

  if (name === 'bootstrap-only') return [bootstrap];
  // "mixed": bootstrap is the most frequent call a real SPA makes (every route change, per
  // 03-API-CONTRACT.md's 304 story), lists are next, health checks are rare (a load balancer, not
  // a user).
  return [bootstrap, bootstrap, bootstrap, campaigns, campaigns, users, health];
}

function percentile(sortedSamples, p) {
  if (sortedSamples.length === 0) return 0;
  const rank = Math.min(sortedSamples.length - 1, Math.ceil((p / 100) * sortedSamples.length) - 1);
  return sortedSamples[Math.max(0, rank)];
}

function summarise(results) {
  const byName = new Map();
  for (const result of results) {
    const bucket = byName.get(result.name) || [];
    bucket.push(result);
    byName.set(result.name, bucket);
  }

  const rows = [];
  for (const [name, entries] of byName) {
    const latencies = entries.map((e) => e.elapsedMs).sort((a, b) => a - b);
    const errors = entries.filter((e) => e.status === 0 || e.status >= 500).length;
    const rateLimited = entries.filter((e) => e.status === 429).length;
    rows.push({
      name,
      count: entries.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] || 0,
      errors,
      errorRate: entries.length > 0 ? errors / entries.length : 0,
      rateLimited,
    });
  }
  return rows;
}

function printSummary(label, rows) {
  console.log(`\n--- ${label} ---`);
  for (const row of rows) {
    console.log(
      `  ${row.name.padEnd(16)} n=${String(row.count).padEnd(6)} ` +
        `p50=${row.p50.toFixed(1).padStart(7)}ms p95=${row.p95.toFixed(1).padStart(7)}ms ` +
        `p99=${row.p99.toFixed(1).padStart(7)}ms max=${row.max.toFixed(1).padStart(8)}ms ` +
        `errors=${String(row.errors).padStart(4)} (${(row.errorRate * 100).toFixed(2)}%) ` +
        `429s=${String(row.rateLimited)}`,
    );
  }
}

/**
 * Fires `rps` requests/second for `durationSeconds`, cycling through `requests` round-robin, and
 * returns every individual result. Requests are *launched* on a fixed schedule (not awaited
 * in-line) so a slow response does not throttle the send rate — exactly what a real burst of
 * concurrent users looks like, and the reason `Promise.all` on a schedule (not a tight loop) is
 * the right primitive here rather than the `for await` sequential style the e2e specs use for
 * per-request p95 measurement.
 */
async function runPhase(baseUrl, requests, cookies, rps, durationSeconds) {
  const intervalMs = 1000 / rps;
  const total = Math.round(rps * durationSeconds);
  const pending = [];
  let actorCursor = 0;
  for (let i = 0; i < total; i += 1) {
    const spec = requests[i % requests.length];
    let headers = {};
    if (spec.authenticated && cookies.length > 0) {
      // A fresh actor on every send (not every *spec*) — the round-robin this file's header
      // ("Why more than one actor") and `buildWorkload`'s own comment describe.
      const cookie = cookies[actorCursor % cookies.length];
      actorCursor += 1;
      if (cookie) headers = { Cookie: cookie };
    }
    pending.push(
      timedRequest(baseUrl, spec.path, { method: spec.method, headers }).then((r) => ({
        name: spec.name,
        ...r,
      })),
    );
    if (i < total - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return Promise.all(pending);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  console.log(`T-053 load-test.js — target ${args.baseUrl}`);

  let cookies = [];
  if (args.credentialsPath) {
    const credentials = JSON.parse(require('node:fs').readFileSync(args.credentialsPath, 'utf8'));
    console.log(`Logging in ${String(credentials.length)} actor(s) from ${args.credentialsPath}...`);
    cookies = await loginAll(args.baseUrl, credentials);
    console.log(`Login OK for all ${String(cookies.length)} actor(s).`);
    if (args.rps > credentials.length * 5) {
      console.log(
        `⚠ ${String(args.rps)} rps across ${String(credentials.length)} actor(s) is ` +
          `${(args.rps / credentials.length).toFixed(1)} rps/actor — above the 5 rps/actor ` +
          "T-012's AUTHENTICATED_API_LIMIT (300/min) allows before a healthy actor starts " +
          '429ing on its own account for a reason unrelated to system load. Add more actors to ' +
          '--credentials for a sustained-phase number that reflects the API, not the throttle.',
      );
    }
  } else if (args.email && args.password) {
    console.log(`Logging in as ${args.email}...`);
    cookies = [await login(args.baseUrl, args.email, args.password)];
    console.log('Login OK.');
    if (args.rps > 5) {
      console.log(
        `⚠ ${String(args.rps)} rps against a single actor is above T-012's AUTHENTICATED_API_LIMIT ` +
          "(300 req/user/minute = 5 rps/user) — most requests will 429 against that actor's own " +
          'throttle, not measure the API under load. Use --credentials with several actors instead.',
      );
    }
  } else {
    console.log('No --email/--password/--credentials given — running unauthenticated requests only.');
  }

  const requests = buildWorkload(args.workload);

  // 630s (70% of the access token's 900s `Max-Age`) — comfortable margin before expiry, and
  // frequent enough that even the longest run this driver's own flags can express (an hour-plus
  // `--duration`) never goes stale. A no-op (nothing to refresh) for any short run — the timer
  // fires at most once or twice before `stopRefreshing()` below, harmlessly.
  const ACCESS_TOKEN_REFRESH_INTERVAL_MS = 630_000;
  const stopRefreshing =
    cookies.length > 0 ? startCookieRefresher(args.baseUrl, cookies, ACCESS_TOKEN_REFRESH_INTERVAL_MS) : () => {};

  console.log(`\nSustained phase: ${String(args.rps)} rps for ${String(args.durationSeconds)}s...`);
  const sustained = await runPhase(args.baseUrl, requests, cookies, args.rps, args.durationSeconds);
  printSummary(`Sustained @ ${String(args.rps)} rps for ${String(args.durationSeconds)}s`, summarise(sustained));

  const totalErrors = sustained.filter((r) => r.status === 0 || r.status >= 500).length;
  if (totalErrors > 0) {
    console.log(`\n⚠ ${String(totalErrors)} error(s) (network failure or 5xx) during the sustained phase.`);
  } else {
    console.log('\n✓ Zero errors during the sustained phase.');
  }

  if (args.spikeRps) {
    console.log(
      `\nSpike phase: ${String(args.spikeRps)} rps for ${String(args.spikeDurationSeconds)}s...`,
    );
    const spike = await runPhase(args.baseUrl, requests, cookies, args.spikeRps, args.spikeDurationSeconds);
    const rows = summarise(spike);
    printSummary(`Spike @ ${String(args.spikeRps)} rps for ${String(args.spikeDurationSeconds)}s`, rows);

    const crashed = spike.filter((r) => r.status === 0).length;
    const rateLimited = spike.filter((r) => r.status === 429).length;
    const serverErrors = spike.filter((r) => r.status >= 500).length;
    console.log(
      `\nSpike result: ${String(crashed)} connection failure(s), ${String(serverErrors)} 5xx, ` +
        `${String(rateLimited)} rate-limited (429). Graceful degradation means the last number is` +
        ' > 0 and the first two are 0 — the limiter engaging, not the process falling over.',
    );
  }

  stopRefreshing();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
