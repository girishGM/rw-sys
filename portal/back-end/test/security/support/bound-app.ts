/**
 * T-051 — bind a Nest test application to **one** real port, once, and hand back a base URL for
 * `supertest` to aim at.
 *
 * ## Why this exists (found while auditing, 2026-08-23)
 *
 * The idiomatic `request(app.getHttpServer())` looks like it addresses an in-process server. It
 * does not. When the server passed to `supertest` is not already listening, `superagent` calls
 * `server.listen(0)` itself, reads `server.address().port`, issues the request over real TCP to
 * `127.0.0.1:<port>`, and closes the listener afterwards — **per request**.
 *
 * For a suite issuing a handful of requests that is harmless. This audit's role × endpoint matrix
 * issues over a thousand (6 roles × ~174 routes), and `route-inventory`/`hardening` add hundreds
 * more. At that volume the listen/close churn races: the port read from `address()` can be one
 * that has already been rebound by another listener in the same process, and the request is then
 * answered by **a different server entirely**.
 *
 * This was not a theoretical concern — it was caught reading a real assertion failure:
 *
 * ```
 * tenant_admin GET /api/v1/definition-requests/:id → 200 for id 999999999:
 *   [{"domain":"base","commands":[{"name":"enableDebugger"},{"name":"restartNode"}, …
 *   ct=application/json len=34198
 * ```
 *
 * That body is the **Node inspector's** protocol descriptor, not the portal's. The suite had
 * reported a 200 where the portal had returned nothing at all, which in the IDOR assertion reads
 * as *"a handler answered 200 for an id that cannot exist"* — a false Critical finding. The same
 * race can flip a reading the other way and mark a genuinely broken control as passing, which is
 * the direction that actually matters for an audit: a security suite whose measurements are
 * occasionally of the wrong server cannot support any conclusion, positive or negative.
 *
 * Binding once removes the churn completely, and is also the more faithful arrangement: one
 * long-lived listener serving many requests is what a deployed process does.
 *
 * Reproduction rate before the fix, measured over full-suite runs: roughly 1 run in 5, landing on
 * a different route/role/assertion each time. After: see the completion report.
 */
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'net';

/**
 * Starts `app` listening on a loopback ephemeral port and returns its base URL
 * (e.g. `http://127.0.0.1:54123`). Pass that string to `supertest`'s `request(...)`.
 *
 * Safe to call after `app.init()`; Nest's `listen()` initialises on demand and tolerates an
 * already-initialised application. `app.close()` releases the listener as usual.
 */
export async function bindTestServer(app: INestApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address();
  if (address === null || typeof address === 'string') {
    throw new Error(`expected a bound TCP address, got ${JSON.stringify(address)}`);
  }

  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

/**
 * T-087 — the same guarantee as `bindTestServer`, for a helper that is *handed* an application it
 * does not own the lifecycle of.
 *
 * `bindTestServer` is the right call when the suite builds the app and can bind it once in
 * `beforeAll`. Shared helpers like `test/auth/support/super-admin-mfa.ts` (imported by 26 e2e
 * suites) and `test/transport-crypto/support/journey-client.ts` are in the opposite position: they
 * receive an `INestApplication` and cannot know whether their caller already bound it. Calling
 * `bindTestServer` unconditionally would throw `ERR_SERVER_ALREADY_LISTEN` for the callers that
 * did; not calling it leaves the per-request listen/close churn in place for the callers that
 * didn't.
 *
 * So: reuse the existing listener when there is one, bind once when there isn't. Idempotent, which
 * makes it safe to call on every request without tracking state in the caller.
 */
export async function boundBaseUrl(app: INestApplication): Promise<string> {
  const address = app.getHttpServer().address();
  if (address === null) return bindTestServer(app);

  if (typeof address === 'string') {
    throw new Error(`expected a bound TCP address, got ${JSON.stringify(address)}`);
  }

  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}
