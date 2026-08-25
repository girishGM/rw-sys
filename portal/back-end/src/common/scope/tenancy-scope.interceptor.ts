/**
 * T-013 — layer 9 of 00-ARCHITECTURE.md §6: *"the multi-tenancy guarantee"*.
 *
 * Its entire job is one line — put the verified JWT's scope into `AsyncLocalStorage` for the
 * duration of the request — and the only interesting thing about it is **how** that line is
 * written, because the obvious way is wrong in a manner that passes every sequential test.
 *
 * ### The subscription trap (T-013 TC-21/TC-22)
 *
 * The natural implementation is:
 *
 * ```ts
 * // WRONG — do not restore this
 * return ScopeContext.run(scope, () => next.handle());
 * ```
 *
 * `next.handle()` does not run the route handler. It *builds an observable* that runs the
 * handler when something subscribes to it — and the subscriber is Nest, later, outside this
 * callback. So `run()` has already returned by the time the handler executes, and the handler
 * sees whatever async context happens to be current: usually none (a 500 from
 * `MissingScopeContextError`, which at least fails safe), but under concurrency, potentially
 * **another request's** context, because the two share the event loop. That is a cross-tenant
 * read that no single-request test can reproduce.
 *
 * The form below moves the `run()` inside the subscription, so the handler and everything it
 * awaits execute within the store:
 *
 * ```ts
 * new Observable((subscriber) => ScopeContext.run(scope, () => next.handle().subscribe(subscriber)))
 * ```
 *
 * `run()` returns whatever its callback returns — here the `Subscription` — which is exactly
 * what the `Observable` constructor wants as its teardown, so unsubscribing (a client
 * disconnect, a timeout interceptor upstream) still cancels the inner chain correctly.
 *
 * `tenancy-scope.interceptor.spec.ts` asserts the property directly, and `rbac.e2e-spec.ts`
 * runs 500 interleaved mixed-tenant requests through the real chain (TC-22). The task file is
 * explicit that flakiness in those is not flakiness: *"it is a real isolation bug"*.
 *
 * ### What is deliberately not here
 *
 * No fallback for a request with no `authUser`. On a `@Public()` route there is no actor, so no
 * scope is established, and any scoped query from such a route fails loudly rather than running
 * as somebody. On a non-public route `authUser` is guaranteed by `JwtAuthGuard` — and if it is
 * somehow absent, establishing an invented scope would be far worse than not establishing one.
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { CHAIN_SPAN, traceSpan } from '@/common/tracing/span.service';
import { ScopeContext, type RequestScope } from './scope-context';

@Injectable()
export class TenancyScopeInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenancyScopeInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // T-019 wrapped the resolution — and only the resolution — in `scope.resolve`, stage 5 of
    // 08-OBSERVABILITY.md §5's waterfall. Deliberately not the whole of `intercept`: everything
    // after this line merely *constructs* an observable, so a span around it would report ~0 ms
    // and hide the work this stage actually does. `traceSpan` is a no-op outside a request.
    const scope = traceSpan(CHAIN_SPAN.SCOPE_RESOLVE, () => this.scopeFor(context));
    if (scope === null) return next.handle();

    return new Observable((subscriber) =>
      // See the header. The subscription — and therefore the handler — must happen *inside*
      // `run`, not merely the construction of the observable.
      ScopeContext.run(scope, () => next.handle().subscribe(subscriber)),
    );
  }

  /**
   * Builds the scope from `request.authUser` — the object `JwtAuthGuard` populates from verified
   * RS256 claims, and the only object in the process that carries these four values.
   *
   * There is no other input. Not a header, not a query parameter, not a body field
   * (AGENT-PROTOCOL R3). A grep for `countryId`/`tenantId`/`merchantId` in this file returns
   * exactly the five lines below, all of them reads of `authUser`.
   */
  private scopeFor(context: ExecutionContext): RequestScope | null {
    // Non-HTTP contexts (the gRPC port of T-047, the scheduler) have no Express request and no
    // portal session; they carry their own service identity and their own scoping. Returning
    // null means "establish nothing", which leaves scoped queries from such a context failing
    // loudly — the correct outcome until a task deliberately gives them a scope.
    if (context.getType() !== 'http') return null;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authUser = request.authUser;
    if (authUser === undefined) {
      this.logger.debug('No authenticated user on this request — no scope context established');
      return null;
    }

    return {
      userId: authUser.userId,
      role: authUser.role,
      countryId: authUser.countryId,
      tenantId: authUser.tenantId,
      merchantId: authUser.merchantId,
    };
  }
}
