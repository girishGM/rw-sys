/**
 * T-013 — the public surface of the tenancy-scope layer, for Wave 3.
 *
 * A feature service needs exactly two of these: `ScopedRepository` (injected) and
 * `ScopeViolationError` (thrown when a lookup returns nothing). `ScopeContext` is exported for
 * the rare caller that must establish a scope outside the HTTP chain — a background job, say —
 * and every such use is a decision that belongs in a review, not a convenience.
 */
export * from './scope-context';
export * from './scope-strategy';
export * from './scope.exceptions';
export * from './scope.module';
export * from './scoped.repository';
export * from './tenancy-scope.interceptor';
