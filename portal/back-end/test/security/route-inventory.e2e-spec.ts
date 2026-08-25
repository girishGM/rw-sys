/**
 * T-051 TC-1 — the route-guard inventory against the **real** `AppModule`.
 *
 * 02-SECURITY.md §11 asks for three things this file answers, and 03-API-CONTRACT.md §15 requires
 * that answering them "fails the build" rather than producing a report nobody reads:
 *
 *  - *"No endpoint lacking `@Roles` or an explicit, reviewed `@Public()`"*
 *  - *"Automated route inventory test: every registered route is either `@Public()` or guarded"*
 *  - *"`GET /` with no cookies returns 401 on every non-public route"*
 *
 * The unit half (`route-inventory.spec.ts`) proves the detector finds an unguarded route when one
 * exists. This half points it at the application that ships.
 *
 * ---
 *
 * ## The divergence from §15, and why this file does not simply encode what it found
 *
 * §15 lists six public routes and says "anything else is a bug". The running application has
 * **nine**: all six of §15's, plus three.
 *
 * | Route | Status |
 * |---|---|
 * | `POST /api/v1/auth/mfa/enrol` | in the code, **not** in §15 |
 * | `POST /api/v1/auth/mfa/verify` | in the code, **not** in §15 |
 * | `POST /api/v1/auth/mfa/recover` | in the code, **not** in §15 |
 *
 * All three were introduced by architect review AR-08 / T-055 and are specified in
 * 02-SECURITY.md **§2a**, which post-dates §15's enumeration. They are `@Public()` in the sense
 * that word carries here — *no access token required* — but they are not unauthenticated: each
 * one's credential is the short-lived `MFA_PENDING` token, verified by `MfaService` before
 * anything happens, and each is rate-limited (5 per 15 min, per IP and per pending token). That
 * is structurally the same shape as `POST /auth/refresh`, which §15 *does* list, and for the same
 * reason: requiring an access token would make the endpoint unreachable in the only state anybody
 * needs it.
 *
 * So the divergence is **§15 being stale**, not the code being wrong. Correcting a design document
 * is an architect decision, not an implementing agent's (AGENT-PROTOCOL §3/§7), so this file does
 * the one thing that is both honest and safe: it holds §15's list verbatim in
 * {@link CONTRACT_PUBLIC_ROUTES}, holds the divergence separately in
 * {@link REVIEWED_PUBLIC_ADDITIONS} with the justification above attached to each entry, and fails
 * if the public set is anything other than exactly those two lists reconciled. A seventh MFA route
 * — or any other new `@Public()` — fails the build, which is what §15 asked for. Recorded as
 * finding **F-1** in `project-plan/reports/T-051-security-review.md`.
 */
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { asExpressApplication, configureHttpSecurity } from '@/common/security/security.middleware';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import {
  MemoryThrottleStore,
  THROTTLE_STORE,
  type ThrottleCounter,
  type ThrottleStore,
} from '@/common/security/throttle.store';
import {
  CONTRACT_PUBLIC_ROUTES,
  classify,
  collectGuardedRoutes,
  type GuardedRoute,
} from './support/route-guard-inventory';
import { bindTestServer } from './support/bound-app';

jest.setTimeout(600_000);

/**
 * A memory store whose counters can be cleared on demand.
 *
 * **Why this is here, and why it does not weaken anything.** The anonymous sweep below issues one
 * request per registered route — ~173 of them — from a single source address. 02-SECURITY.md §8
 * caps unauthenticated traffic at 60 per IP per minute, so the first run of this file produced a
 * long list of `429`s: the limiter working exactly as designed, and completely uninformative about
 * the property under test, which is *"an anonymous caller reaches nothing"*.
 *
 * The alternatives were to pace the sweep at 60/min (three minutes of sleeping per pass, for no
 * additional assurance) or to clear the counter, which is what waiting would have achieved anyway.
 * Nothing about the limiter's configuration is changed — the rules, the limits and the windows are
 * the real ones — and the limiter itself is verified independently: by `hardening.e2e-spec.ts`
 * (T-012's own suite, which owns it) and by TC-17 in `role-matrix.e2e-spec.ts`, which drives the
 * unauthenticated ceiling to its limit against the **unmodified** store and asserts the 429.
 */
class ResettableThrottleStore implements ThrottleStore {
  readonly kind = 'memory' as const;
  private delegate = new MemoryThrottleStore();

  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    return this.delegate.consume(key, windowMs, now);
  }

  reset(): void {
    this.delegate = new MemoryThrottleStore();
  }
}

/** Cleared often enough that the 60/min unauthenticated ceiling is never the thing under test. */
const RESET_EVERY = 40;

/**
 * Public routes the application has that §15 does not list — each with the reason it is
 * acceptable. **Adding an entry here is a security decision that must appear in a reviewed diff**,
 * which is the whole point of writing them down rather than filtering by a path prefix.
 */
const REVIEWED_PUBLIC_ADDITIONS: ReadonlyMap<string, string> = new Map([
  [
    'POST /api/v1/auth/mfa/enrol',
    'AR-08 / T-055, specified in 02-SECURITY.md §2a. Credential is the MFA_PENDING token, not a ' +
      'session; MfaService refuses everything else, and re-enrolment is rejected once ' +
      'mfa_enabled is true. Rate-limited 5/15min per pending token.',
  ],
  [
    'POST /api/v1/auth/mfa/verify',
    'AR-08 / T-055, specified in 02-SECURITY.md §2a. Same MFA_PENDING credential; this is where ' +
      'the session is finally minted. Rate-limited 5/15min per IP and per pending token.',
  ],
  [
    'POST /api/v1/auth/mfa/recover',
    'AR-08 / T-055, specified in 02-SECURITY.md §2a. Same MFA_PENDING credential; consumes one ' +
      'single-use recovery code and audits mfa_recovery_used.',
  ],
]);

let app: INestApplication;
let routes: GuardedRoute[];
let store: ResettableThrottleStore;

/** Set once in `beforeAll` by `bindTestServer` — see that helper for why this is not
 *  `request(app.getHttpServer())`. */
let baseUrl: string;

function http() {
  return request(baseUrl);
}

beforeAll(async () => {
  store = new ResettableThrottleStore();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(THROTTLE_STORE)
    .useValue(store)
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>();
  // Identical to main.ts: an inventory taken from a differently-configured application would be
  // an inventory of something nobody runs.
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  configureHttpSecurity(asExpressApplication(app), {
    apiOrigin: process.env.API_ORIGIN ?? 'https://api.t051.example.test',
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
    trustProxy: undefined,
    enforceHttps: false,
  });
  baseUrl = await bindTestServer(app);

  routes = collectGuardedRoutes(app);
});

afterAll(async () => {
  await app?.close();
});

describe('TC-1: every registered route is @Public() or guarded', () => {
  it('found a real inventory — not an empty one', () => {
    // Every assertion below is vacuously true against an empty array. This is the guard against a
    // container-traversal change silently turning the whole file into a no-op.
    expect(routes.length).toBeGreaterThan(100);
    expect(new Set(routes.map((route) => route.controller)).size).toBeGreaterThan(20);
    expect(routes.some((route) => route.method === 'GET')).toBe(true);
    expect(routes.some((route) => route.method === 'POST')).toBe(true);
    expect(routes.some((route) => route.method === 'DELETE')).toBe(true);
  });

  it('has NO route without @Public(), @Roles() or @RequirePermission()', () => {
    const unguarded = classify(routes).unguarded;

    // Named in the failure message: "expected 0, got 3" would send the next reader back to the
    // container to find out which three.
    expect(
      unguarded.map((route) => `${route.signature}  (${route.controller}.${route.handler})`),
    ).toEqual([]);
  });

  it('accounts for every route in exactly one class', () => {
    const classified = classify(routes);

    expect(
      classified.publicRoutes.length +
        classified.roleGuarded.length +
        classified.permissionOnly.length +
        classified.unguarded.length,
    ).toBe(routes.length);
  });
});

describe('TC-1: the @Public() list against 03-API-CONTRACT.md §15', () => {
  it('contains every one of §15’s six routes', () => {
    const publicSignatures = new Set(classify(routes).publicRoutes.map((route) => route.signature));

    const missing = CONTRACT_PUBLIC_ROUTES.filter((signature) => !publicSignatures.has(signature));

    // Both health routes included: `GET /health/ready` is implemented and `@Public()`. A
    // §15 route that had silently stopped being public — the 401-on-every-probe failure mode —
    // would land here.
    expect(missing).toEqual([]);
  });

  it('contains NOTHING beyond §15 except the three reviewed MFA routes (finding F-1)', () => {
    const publicSignatures = classify(routes).publicRoutes.map((route) => route.signature);

    const unreviewed = publicSignatures.filter(
      (signature) =>
        !CONTRACT_PUBLIC_ROUTES.includes(signature) && !REVIEWED_PUBLIC_ADDITIONS.has(signature),
    );

    // This is the assertion §15 asks to "fail the build". A new @Public() route lands here.
    expect(unreviewed).toEqual([]);
  });

  it('pins the exact public set, so any change to it is a reviewed diff', () => {
    const publicSignatures = classify(routes)
      .publicRoutes.map((route) => route.signature)
      .sort();

    expect(publicSignatures).toEqual(
      [
        'GET /api/v1/health',
        'GET /api/v1/health/ready',
        'POST /api/v1/auth/forgot-password',
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/mfa/enrol',
        'POST /api/v1/auth/mfa/recover',
        'POST /api/v1/auth/mfa/verify',
        'POST /api/v1/auth/refresh',
        'POST /api/v1/auth/reset-password',
      ].sort(),
    );
  });

  it('keeps every reviewed addition justified in writing', () => {
    for (const [signature, justification] of REVIEWED_PUBLIC_ADDITIONS) {
      expect(signature).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//);
      // A blank or token justification defeats the purpose of the list existing.
      expect(justification.length).toBeGreaterThan(80);
    }
  });

  it('does not expose the internal mTLS trust domain on the browser-facing app (§16b)', () => {
    // `POST /internal/v1/campaigns/:id/budget-breach` and the gRPC port carry `MtlsGuard` +
    // `ServiceScopeGuard` and live on a separate listener. If `BudgetBreachController` were ever
    // added to `GrpcModule.controllers`, it would appear here — with no `@Roles` and no
    // `@Public()` — and the unguarded assertion above would already have failed. This states the
    // property directly so the reason is recorded rather than inferred.
    expect(routes.filter((route) => route.path.startsWith('/internal'))).toEqual([]);
    expect(routes.map((route) => route.controller)).not.toContain('BudgetBreachController');
  });
});

/** Path params filled with a value that cannot exist, so nothing is reachable even if admitted. */
export function probePath(route: GuardedRoute): string {
  return `/api/v1${route.path}`
    .replace(/:level\b/g, '1')
    .replace(/:role\b/g, 'merchant')
    .replace(/:policyKey\b/g, 't051-nonexistent-policy')
    .replace(/:correlationId\b/g, '00000000-0000-4000-8000-000000000000')
    .replace(/:[A-Za-z]+/g, '999999999');
}

describe('TC-1 / §11: an anonymous request reaches nothing', () => {
  /**
   * One pass over every non-public route with no cookies at all, collected once and asserted
   * three ways below. Collected once because each pass costs ~173 real HTTP round trips.
   */
  const observed = new Map<GuardedRoute, number>();

  beforeAll(async () => {
    let sinceReset = 0;

    for (const route of routes.filter((entry) => !entry.isPublic)) {
      if (sinceReset++ >= RESET_EVERY) {
        store.reset();
        sinceReset = 0;
      }

      const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      const response = await http()[method](probePath(route)).send({});
      observed.set(route, response.status);
    }
  });

  it('probed a meaningful number of routes', () => {
    expect(observed.size).toBeGreaterThan(100);
    // If the reset cadence ever stopped keeping up with the 60/min ceiling, the sweep would
    // silently become "429 everywhere" and the assertions below would be measuring the limiter
    // rather than the guards. Fail loudly instead.
    expect([...observed.values()].filter((status) => status === 429)).toEqual([]);
  });

  it('returns 401 for every non-public GET with no cookies', () => {
    const wrong = [...observed]
      .filter(([route]) => route.method === 'GET')
      .filter(([, status]) => status !== 401)
      .map(([route, status]) => `${route.signature} → ${status}`);

    expect([...observed].filter(([route]) => route.method === 'GET').length).toBeGreaterThan(50);
    expect(wrong).toEqual([]);
  });

  it('returns 401 on every verb, not just GET — including every mutating route', () => {
    // Verified rather than assumed: a cookie-less mutating request is answered **401**, not 403.
    // `CsrfGuard` runs first (chain position 4) but deliberately passes a request carrying no
    // session and no `rs_csrf` cookie — "no credential material at all → pass", case 3 in
    // `csrf.guard.ts` — because such a request has no ambient authority for a cross-site caller
    // to abuse. `JwtAuthGuard` at position 5 is what refuses it. The first draft of this file
    // asserted 403 here and was wrong about the design, not about the code.
    //
    // TC-11 (a *session-carrying* request with no `X-CSRF-Token`) is the other half of this, and
    // is asserted in `role-matrix.e2e-spec.ts` where real sessions exist.
    const mutating = [...observed].filter(([route]) =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method),
    );
    expect(mutating.length).toBeGreaterThan(20);

    const wrong = mutating
      .filter(([, status]) => status !== 401)
      .map(([route, status]) => `${route.signature} → ${status}`);

    expect(wrong).toEqual([]);
  });

  it('never leaks a 200 — or anything but 401 — to an anonymous caller', () => {
    const wrong = [...observed]
      .filter(([, status]) => status !== 401)
      .map(([route, status]) => `${route.signature} → ${status}`);

    expect(wrong).toEqual([]);
  });
});
