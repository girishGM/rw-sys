/**
 * T-087 — regression coverage for "unit HTTP specs still bind an ephemeral port per request".
 *
 * ## The defect
 *
 * T-085 fixed this for the **e2e** suites and for T-051's security suites (via
 * {@link bindTestServer}). The ~10 back-end *unit* HTTP specs were left on the old form, and
 * T-086 measured the result: 4 red runs in 54 full unit-suite runs (~7%), none of them timing
 * failures, all of them behaviour-shaped and mutually inconsistent — the signature of a request
 * being answered by the wrong server rather than of a real defect.
 *
 * The mechanism, read out of `node_modules/supertest/lib/test.js` rather than inferred:
 *
 * ```js
 * serverAddress(app, path) {
 *   const addr = app.address();
 *   if (!addr) this._server = app.listen(0);   // only when NOT already listening
 *   const port = app.address().port;           // captured in the CONSTRUCTOR
 *   ...
 * }
 * end(fn) { ... server.close(...) ... }        // released once the response lands
 * ```
 *
 * So for an app that only ever called `init()`, every request binds a fresh ephemeral port, the
 * port is fixed at `request(...)` time, and the listener is closed as soon as *a* response lands.
 * Two requests in flight at once — or enough parallel Jest workers churning the same ephemeral
 * range — and the address a request was aimed at is no longer the app's by the time it connects.
 *
 * Why that is a security problem and not merely flakiness: it is **direction-agnostic**. T-086
 * observed `POST /auth/refresh` answering 200 where the handler's first statement makes 200
 * unreachable without a refresh cookie — at the status-code level that is indistinguishable from
 * an auth bypass. The same race can equally mark a genuinely broken control as passing.
 *
 * ## What this file asserts
 *
 * 1. **TC-1** — the defect itself, reproduced three ways: the per-request bind is counted, a
 *    concurrent burst is shown to be unreliable, and — deterministically — a captured URL is
 *    shown being answered by a *different* server.
 * 2. **TC-2** — the fix: bound once, supertest never re-binds, every answer comes from the app,
 *    and the address cannot be taken by anyone else for the app's lifetime.
 * 3. **TC-3** — the invariant that keeps it fixed: no unit spec aims supertest at a
 *    `getHttpServer()` handle. This is the case that goes red if any of the files this task
 *    touched is reverted, and it was proven red by reverting one before it was proven green.
 * 4. **TC-4** — {@link boundBaseUrl}'s adjacent behaviour, since it is the form the two shared
 *    helpers use and it must not double-bind an app its caller already bound.
 *
 * ## No load generation, deliberately
 *
 * An earlier draft reproduced the misroute with a pool of "rogue" listeners churning ephemeral
 * ports. It worked in isolation and then **timed out inside the full unit suite**, because a hot
 * bind/close loop is exactly the kind of load this suite is supposed to be measuring, not adding.
 * Every case below is deterministic or near-deterministic and finishes in milliseconds.
 */
import http from 'node:http';
import net from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { bindTestServer, boundBaseUrl } from './support/bound-app';

jest.setTimeout(30_000);

/**
 * Counts `listen()` calls that come from supertest's own `serverAddress()` — i.e. the per-request
 * ephemeral binds this task exists to remove — as opposed to a deliberate bind in a fixture.
 *
 * Attribution is by call stack, which is how the diagnosis for this task was made against the
 * real suite. Returns a stop function that restores the prototype and yields the count.
 */
function countSupertestBinds(): () => number {
  const original = net.Server.prototype.listen;
  let binds = 0;

  net.Server.prototype.listen = function patched(this: net.Server, ...args: unknown[]) {
    const stack = new Error('listen').stack ?? '';
    if (stack.includes('serverAddress') || stack.includes('supertest/lib/test.js')) binds += 1;
    return (original as (...a: unknown[]) => net.Server).apply(this, args);
  } as typeof net.Server.prototype.listen;

  return () => {
    net.Server.prototype.listen = original;
    return binds;
  };
}

/** A server that identifies itself, so "who answered?" is decidable from the body. */
function serverSaying(name: string): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: name }));
  });
}

const close = async (server: http.Server): Promise<void> => {
  if (server.address() !== null) await new Promise<void>((r) => server.close(() => r()));
};

/** Fires `iterations` concurrent GETs at `target` and classifies who answered each one. */
async function fire(target: string | http.Server, iterations: number): Promise<string[]> {
  return Promise.all(
    Array.from({ length: iterations }, () =>
      request(target as never)
        .get('/probe')
        .then((res) => (res.body as { from?: string }).from ?? 'unknown')
        .catch((err: NodeJS.ErrnoException) => `ERROR:${err.code ?? err.message}`),
    ),
  );
}

describe('T-087 TC-1 — the defect, reproduced', () => {
  it('makes supertest bind a fresh ephemeral port for every single request', async () => {
    const server = serverSaying('real-app');
    const stop = countSupertestBinds();

    // Sequential, so each request completes (and closes its listener) before the next begins —
    // the least favourable case for the bug, and it still binds once per request.
    for (let i = 0; i < 5; i += 1) await request(server).get('/probe');

    expect(stop()).toBe(5);
    // Never listening between requests: the app has no stable address at all.
    expect(server.address()).toBeNull();
    await close(server);
  });

  it('does not reliably answer a concurrent burst from the server under test', async () => {
    const server = serverSaying('real-app');
    const answers = await fire(server, 40);
    await close(server);

    const fromRealApp = answers.filter((a) => a === 'real-app').length;
    // eslint-disable-next-line no-console -- evidence for the completion report
    console.log('[T-087 TC-1, un-bound] answered by the app under test:', fromRealApp, 'of 40');

    // The first response closes the shared listener while the rest are still aimed at it. The
    // property that matters is not a specific count but that the suite is measuring something
    // other than the application: a test built on this cannot support a conclusion either way.
    expect(fromRealApp).toBeLessThan(40);
  });

  it('lets a DIFFERENT server answer a request aimed at the app under test', async () => {
    // The deterministic form of the hazard, with no load generation and no race: supertest fixes
    // the URL when the request is constructed and releases the port when the response lands, so
    // a URL that addressed the app a moment ago can address somebody else now.
    const app = serverSaying('app-under-test');
    const captured = request(app).get('/probe');
    const url = new URL(captured.url);

    const firstAnswer = await captured;
    expect(firstAnswer.body).toEqual({ from: 'app-under-test' });
    // supertest has now closed the listener, so the port is free — exactly the state the next
    // request in a real spec file starts from.
    expect(app.address()).toBeNull();

    const impostor = serverSaying('SOMEONE-ELSE');
    await new Promise<void>((resolve, reject) => {
      impostor.once('error', reject);
      impostor.listen(Number(url.port), '127.0.0.1', resolve);
    });

    const second = await request(url.origin).get('/probe');

    // Same address the app was reached on seconds ago; a completely different process answering.
    // In `auth.http.spec.ts` this is what turned a cookie-less refresh into a 200.
    expect(second.body).toEqual({ from: 'SOMEONE-ELSE' });

    await close(impostor);
    await close(app);
  });
});

describe('T-087 TC-2 — the fix', () => {
  it('binds once for any number of requests, and every answer comes from the app', async () => {
    const server = serverSaying('real-app');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const stop = countSupertestBinds();
    const answers = await fire(base, 40);
    const binds = stop();

    expect(binds).toBe(0);
    expect(answers.filter((a) => a === 'real-app')).toHaveLength(40);

    // And the address cannot be taken from underneath it: the listener is held for the app's
    // whole lifetime, which is what makes TC-1's third case impossible here.
    const impostor = serverSaying('SOMEONE-ELSE');
    await expect(
      new Promise<void>((resolve, reject) => {
        impostor.once('error', reject);
        impostor.listen(port, '127.0.0.1', resolve);
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });

    await close(impostor);
    await close(server);
  });

  it('holds for a real Nest application bound with bindTestServer', async () => {
    @Controller()
    class ProbeController {
      @Get('probe')
      probe(): { from: string } {
        return { from: 'real-app' };
      }
    }

    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    const app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();
    const base = await bindTestServer(app);

    const stop = countSupertestBinds();
    const answers = await fire(base, 30);
    const binds = stop();

    expect(binds).toBe(0);
    expect(answers.filter((a) => a === 'real-app')).toHaveLength(30);
    // Loopback only: a bare `listen(0)` would bind every interface on the machine.
    expect(new URL(base).hostname).toBe('127.0.0.1');

    await app.close();
  });
});

/**
 * The invariant that keeps the ten files fixed.
 *
 * A behavioural test cannot catch somebody reverting one spec back to
 * `request(app.getHttpServer())` — only reading the specs can. This is the same technique
 * `cors.config.spec.ts`'s TC-6 already uses for `origin: true`, and for the same reason: the
 * widening itself is the thing to catch, and it is invisible to any assertion about behaviour.
 */
describe('T-087 TC-3 — no unit spec aims supertest at a getHttpServer() handle', () => {
  /** Every `*.spec.ts` the unit config runs. `*.e2e-spec.ts` is a different config and excluded. */
  function unitSpecs(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'coverage') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) unitSpecs(full, found);
      else if (entry.endsWith('.spec.ts') && !entry.endsWith('.e2e-spec.ts')) found.push(full);
    }
    return found;
  }

  /**
   * Strips block and line comments. Several of the files this task fixed *document* the old form
   * by name in a comment — including this one — so a scan that did not strip comments would
   * report itself.
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  const roots = [join(__dirname, '..'), join(__dirname, '..', '..', 'src')];
  const specs = roots.flatMap((root) => unitSpecs(root));

  it('finds the unit specs at all (guards the scan itself against silently matching nothing)', () => {
    // A scan that walks the wrong directory passes vacuously forever. This is the tripwire.
    expect(specs.length).toBeGreaterThan(200);
  });

  it('finds no request(<app>.getHttpServer()) call in any of them', () => {
    const offenders = specs.filter((file) =>
      /request\(\s*[A-Za-z_$][\w$.]*\.getHttpServer\(\)\s*\)/.test(
        stripComments(readFileSync(file, 'utf8')),
      ),
    );

    expect(offenders.map((f) => f.replace(join(__dirname, '..', '..'), ''))).toEqual([]);
  });
});

describe('T-087 TC-4 — boundBaseUrl, the form the shared helpers use', () => {
  it('binds an un-bound app and returns a loopback URL', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [] }).compile();
    const app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();

    expect(app.getHttpServer().address()).toBeNull();
    const base = await boundBaseUrl(app);

    expect(new URL(base).hostname).toBe('127.0.0.1');
    expect(app.getHttpServer().address()).not.toBeNull();

    await app.close();
  });

  it('is idempotent: a second call reuses the listener rather than throwing', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [] }).compile();
    const app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();

    const first = await boundBaseUrl(app);
    // The failure this guards against is ERR_SERVER_ALREADY_LISTEN: the helpers call it on every
    // request, and 26 e2e suites hand it an app they may already have bound themselves.
    const second = await boundBaseUrl(app);

    expect(second).toBe(first);
    await app.close();
  });

  it('refuses a non-TCP address rather than building a nonsense URL', async () => {
    const fake = {
      getHttpServer: () => ({ address: () => '/tmp/some.sock' }),
    } as unknown as INestApplication;

    await expect(boundBaseUrl(fake)).rejects.toThrow(/expected a bound TCP address/);
  });
});
