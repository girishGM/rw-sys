/**
 * T-013 — DI wiring for layer 9 of 00-ARCHITECTURE.md §6.
 *
 * Two things live here and they are two halves of one guarantee: the interceptor that
 * establishes the scope, registered **globally** so no route can be reached without it, and the
 * repository that refuses to run a query without one.
 *
 * ### Why the interceptor must be global rather than opt-in
 *
 * The same argument `security.module.ts` makes for `RateLimitGuard`: *"a rate limit that only
 * applies to the controllers somebody remembered to annotate is not a rate limit"*. Here it is
 * stronger still, because the failure is silent in the opposite direction — a controller whose
 * interceptor was forgotten does not leak data, it 500s on the first scoped query
 * (`MissingScopeContextError`). That is a good failure, but it is a failure discovered in
 * production rather than prevented, and there is no reason to accept it when global registration
 * costs one line.
 *
 * ### Exported, not global-module
 *
 * `ScopedRepository` is exported for feature modules to import (via `RbacModule`, which
 * re-exports this module). It is deliberately not an `@Global()` module: a Wave 3 module that
 * needs scoped data access should say so in its `imports`, because that import list is the
 * cheapest available answer to "what does this feature touch?".
 *
 * This file is an addition to T-013's declared *Files owned* list, mirroring the precedent
 * T-010/T-011/T-012 set with their own module files. Recorded as a deviation in the completion
 * report.
 */
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScopedRepository } from './scoped.repository';
import { TenancyScopeInterceptor } from './tenancy-scope.interceptor';

@Module({
  providers: [
    ScopedRepository,
    TenancyScopeInterceptor,
    // `useExisting`, not `useClass`, for the reason `security.module.ts` records: the global
    // entry and the exported provider must be the *same instance*, so a future stateful
    // addition to the interceptor cannot end up with two copies of its state.
    { provide: APP_INTERCEPTOR, useExisting: TenancyScopeInterceptor },
  ],
  exports: [ScopedRepository, TenancyScopeInterceptor],
})
export class ScopeModule {}
