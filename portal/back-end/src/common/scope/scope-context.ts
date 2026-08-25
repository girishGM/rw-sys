/**
 * T-013 — the request-scoped tenancy context, and the only place it may be read from.
 *
 * ### What this file is
 *
 * 00-ARCHITECTURE.md §6 calls layer 9 "the multi-tenancy guarantee" and states the rule this
 * file exists to make mechanical:
 *
 * > Repositories never receive a raw `tenant_id` from a controller. They read it from an
 * > `AsyncLocalStorage` scope context populated only from the verified JWT. A missing scope
 * > context is a hard 500, never a silent full-table query.
 *
 * Both halves matter and they are load-bearing in opposite directions:
 *
 *  - **Populated only from the verified JWT.** `TenancyScopeInterceptor` is the *only* writer,
 *    and it reads `request.authUser`, which `JwtAuthGuard` is in turn the only writer of. That
 *    is a two-link chain from an RS256 signature to a WHERE clause with no branch in it where a
 *    header, a query parameter or a DTO field could join (AGENT-PROTOCOL R3).
 *  - **Absent context throws.** {@link ScopeContext.require} has no default, no fallback and no
 *    "unscoped" mode. A missing context means a repository call happened outside a request — a
 *    programming error — and the only two things it could do are fail loudly or return every
 *    tenant's rows. T-013 implementation note 2 picks the first, and this file has no code path
 *    that could implement the second (TC-13).
 *
 * ### Why `AsyncLocalStorage` rather than a request-scoped Nest provider
 *
 * Nest's `Scope.REQUEST` would work, but it infects the entire injection chain: every service
 * that transitively touches a request-scoped provider becomes request-scoped too, is
 * re-instantiated per request, and — crucially — a developer who forgets to propagate it gets a
 * silently *shared* singleton instead of a loud failure. `AsyncLocalStorage` is the opposite
 * shape: nothing is injected, nothing is re-instantiated, and the failure mode of forgetting to
 * establish the context is {@link MissingScopeContextError}, not a wrong answer.
 *
 * The classic hazard with `AsyncLocalStorage` is context *leaking* between concurrent requests,
 * which is what T-013 TC-21/TC-22 exist to catch. That hazard lives in the interceptor (how the
 * store is entered relative to the observable's subscription), not here — see
 * `tenancy-scope.interceptor.ts`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PortalRole } from '@/database/portal-models';

/**
 * The actor's scope, as established by the guard chain and used by every scoped query.
 *
 * `userId` is part of it, not because it is part of "the scope triple" (00-ARCHITECTURE.md
 * §5.1 names only country/tenant/merchant), but because several tables are scoped to the
 * *owner* rather than to a tenant — `user_notifications` is "own only" (03-API-CONTRACT.md
 * §14), as are a user's own sessions. Carrying it here means those models get the same
 * WHERE-clause treatment as every other model instead of an ad-hoc filter per endpoint.
 *
 * Every field is `readonly` and the object is frozen on entry: a scope that could be mutated
 * mid-request by the code it constrains is not a constraint.
 */
export interface RequestScope {
  readonly userId: number;
  readonly role: PortalRole;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
}

/**
 * Thrown when scoped data access is attempted with no scope context established.
 *
 * Deliberately **not** an `HttpException`. This is a programming error — a repository call from
 * a cron job, a CLI, a `setTimeout` that escaped the request, or a route whose interceptor was
 * never wired — and Nest's default handling of a non-HTTP error is a 500 with no body detail,
 * which is exactly right. Making it a 403 or a 404 would let a wiring bug look like an
 * ordinary authorisation outcome and survive review.
 */
export class MissingScopeContextError extends Error {
  constructor(operation: string) {
    super(
      `Scoped data access (${operation}) was attempted with no ScopeContext. ` +
        'This is a wiring error: the call is running outside a request, or outside ' +
        'TenancyScopeInterceptor. Scoped queries are never run unscoped.',
    );
    this.name = 'MissingScopeContextError';
  }
}

const storage = new AsyncLocalStorage<RequestScope>();

/**
 * The scope context. A namespace of functions rather than an injectable service, because
 * `AsyncLocalStorage` is process-global by nature and injecting it would imply — falsely — that
 * two instances could coexist and mean different things.
 */
export const ScopeContext = {
  /**
   * Runs `fn` with `scope` established. Everything `fn` awaits, schedules or subscribes to
   * inherits it; nothing outside does.
   *
   * The scope is frozen rather than copied-on-read: freezing catches a mutation attempt at the
   * point of the bug, whereas copying would let the mutation succeed against a discarded object
   * and fail somewhere else entirely.
   */
  run<T>(scope: RequestScope, fn: () => T): T {
    return storage.run(Object.freeze({ ...scope }), fn);
  },

  /** The current scope, or `undefined` outside a request. Prefer {@link require}. */
  current(): RequestScope | undefined {
    return storage.getStore();
  },

  /**
   * The current scope, or throw.
   *
   * `operation` is a label for the error message only — it never reaches a client (the error is
   * a 500 with no body detail); it exists so the server log names the call site.
   */
  require(operation: string): RequestScope {
    const scope = storage.getStore();
    if (scope === undefined) throw new MissingScopeContextError(operation);
    return scope;
  },

  /**
   * Whether a scope is currently established.
   *
   * Exists for diagnostics and for code that must behave differently outside a request (the
   * migration CLI, for instance). It is **not** an escape hatch: there is no API here that
   * returns rows when this is `false`.
   */
  isActive(): boolean {
    return storage.getStore() !== undefined;
  },
} as const;
