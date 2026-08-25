/**
 * T-085 — regression coverage for "e2e suites bind a new ephemeral port per request; high-volume
 * suites can be answered by another listener".
 *
 * ## The defect, reproduced without Nest or Postgres
 *
 * `request(app.getHttpServer())` looks like it talks to an in-process server. It does not, unless
 * that server is already listening. `supertest`'s own `serverAddress()`
 * (`node_modules/supertest/lib/test.js`) is exactly this:
 *
 * ```js
 * const addr = app.address();
 * if (!addr) this._server = app.listen(0);       // only when NOT already listening
 * const port = app.address().port;
 * ```
 *
 * A Nest app that only ever called `app.init()` (never `app.listen()`) has an `http.Server` whose
 * `.address()` is `null` — so every single request makes supertest bind a **fresh** ephemeral
 * port, read it back, connect, and close the listener again. Under concurrency, that per-request
 * listen/close churn races anything else in the same process that is also binding ephemeral ports
 * (the exact failure this task was filed to fix: T-051's audit measured `~29%` of six high-volume
 * security suites' runs answered by a stray listener instead of the portal). Binding once, up
 * front — `await app.listen(0)` instead of `await app.init()` — removes the churn entirely,
 * because `app.address()` is non-null from then on and `serverAddress()` never re-binds.
 *
 * This file proves that property directly, with plain `http.Server`s and no application code, so
 * it runs in milliseconds and needs neither Postgres nor a compiled Nest module. The four real
 * files this task fixed (`test/app.e2e-spec.ts`, `test/auth/auth.e2e-spec.ts`,
 * `test/auth/bootstrap-superadmin.e2e-spec.ts`, `test/auth/mfa.e2e-spec.ts` — see the completion
 * report for why exactly these four and not the other 28 `request(app.getHttpServer())` sites,
 * which already called `app.listen(0)` and were never actually affected) are the applied instance
 * of the same property this file checks structurally.
 *
 * ## TC-3 discipline (AGENT-PROTOCOL §4)
 *
 * `unboundServerFailureRate` below is run twice: once against a server that mimics the pre-fix
 * `app.init()`-only state (never bound), and once against a server bound once up front, the way
 * every fixed file now does it. TC-1 asserts the first is unreliable; TC-2 asserts the second is
 * not. Toggling which branch `bindFirst` takes in TC-2 to `false` (i.e. reverting the fix) makes
 * TC-2 fail — checked by hand while writing this file, not asserted by the suite itself, since
 * asserting "this test fails when broken" from inside the test that must also pass is not
 * meaningful.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

jest.setTimeout(30_000);

/**
 * Starts a churn of short-lived listeners on ephemeral ports, mimicking "another listener in the
 * process" — anything else in the same Jest worker binding `listen(0)` around the same time
 * (another suite's fixture, a debugger, or — as here — the same bug in a neighbouring request).
 * Each rogue listener answers with a body that is trivially distinguishable from the real server's.
 */
function startRogueChurn(openMs: number): () => void {
  let stopped = false;

  (async () => {
    while (!stopped) {
      const rogue = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ from: 'ROGUE' }));
      });
      await new Promise<void>((resolve) => rogue.listen(0, resolve));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, openMs);
      });
      await new Promise<void>((resolve) => rogue.close(() => resolve()));
    }
  })();

  return () => {
    stopped = true;
  };
}

interface ChurnResult {
  iterations: number;
  fromRealApp: number;
  fromRogue: number;
  errored: number;
}

/**
 * Fires `iterations` concurrent GETs at `server` via `supertest`, exactly the pattern every
 * affected file used (`Promise.all([...].map(() => request(app.getHttpServer())...))` — T-011's
 * own TC-15 does this for real). `bindFirst` selects which side of the defect is under test:
 * `false` reproduces the pre-fix state (`app.init()` only, `server.listen()` never called),
 * `true` reproduces the fix (`app.listen(0)` once, before any request).
 */
async function churnAgainst(bindFirst: boolean, iterations: number): Promise<ChurnResult> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: 'real-app' }));
  });

  if (bindFirst) {
    await new Promise<void>((resolve) => server.listen(0, resolve));
  }

  const stopRogue = startRogueChurn(2);

  const results = await Promise.all(
    Array.from({ length: iterations }, () =>
      request(server)
        .get('/probe')
        .then((res) => (res.body as { from?: string }).from ?? 'unknown')
        .catch((err: NodeJS.ErrnoException) => `ERROR:${err.code ?? err.message}`),
    ),
  );

  stopRogue();
  if (server.address() !== null)
    await new Promise<void>((resolve) => server.close(() => resolve()));

  return {
    iterations,
    fromRealApp: results.filter((r) => r === 'real-app').length,
    fromRogue: results.filter((r) => r === 'ROGUE').length,
    errored: results.filter((r) => r.startsWith('ERROR')).length,
  };
}

describe('T-085 TC-1 — reproduces the reported defect: a never-bound server under concurrency', () => {
  it('fails to answer a large share of concurrent requests when the server is never listen()ed', async () => {
    const result = await churnAgainst(false, 60);

    // eslint-disable-next-line no-console -- evidence for the completion report
    console.log('[T-085 TC-1, unfixed]', result);

    // Not "all fail" — the race is inherently timing-dependent (T-051's own measurement was
    // ~29% over full suites). What must hold, reliably, is that an unbound server under
    // concurrent churn is measurably unreliable — the exact property that makes it unsafe to
    // build an assertion on.
    expect(result.fromRealApp).toBeLessThan(result.iterations * 0.5);
  });
});

describe('T-085 TC-2 — the fix: binding once before any request removes the churn', () => {
  it('answers every concurrent request correctly once the server is bound up front', async () => {
    const result = await churnAgainst(true, 60);

    // eslint-disable-next-line no-console -- evidence for the completion report
    console.log('[T-085 TC-2, fixed]', result);

    expect(result.fromRogue).toBe(0);
    expect(result.errored).toBe(0);
    expect(result.fromRealApp).toBe(result.iterations);
  });
});

describe('T-085 TC-4 — adjacent behaviour: binding once still yields a real, connectable address', () => {
  it('exposes a loopback-reachable port after a single listen(0)', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe('string');
    expect((address as AddressInfo).port).toBeGreaterThan(0);

    const response = await request(server).get('/');
    expect(response.status).toBe(200);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
