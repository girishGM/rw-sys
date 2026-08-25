/**
 * T-020 — the second link of the guard chain (04-FRONTEND.md §2). Blocks rendering of its
 * children until `/me/bootstrap` has resolved, so the UI never flashes a menu — or any
 * other content gated on entitlements — that the caller is not entitled to (TC-2, TC-9).
 *
 * Four states, in priority order:
 * 1. Unauthorized — render nothing; `RequireAuth`, the parent in the chain, is the one that
 *    performs the redirect, so there is nothing useful to show here in the single frame
 *    before it does.
 * 2. T-024 — confined (`isPasswordChangeRequired`, a 403 `PASSWORD_CHANGE_REQUIRED`
 *    from `/me/bootstrap`, 02-SECURITY.md §2): redirect to `/change-password`. `/me/bootstrap`
 *    is not one of the two routes a confined session may reach, so every route in this guard
 *    chain 403s the same way for a user who has not yet cleared a forced password change —
 *    without this branch that would fall into the generic `isError` case below and dead-end on
 *    a "Something went wrong / Retry" page that would only ever 403 again. Redirecting instead
 *    is what T-024's "no nav, no escape" requirement means in practice for every route *other*
 *    than `/change-password` itself: there is nowhere else a confined session can usefully end
 *    up.
 * 3. No data yet (`isLoading`) — a full-page skeleton. Never a spinner (04-FRONTEND.md §10:
 *    "Skeletons, never spinners... layout stability over spinner churn") and, critically,
 *    **no nav items** (TC-9) — this component has no access to real nav content anyway,
 *    since its own children (the actual page) have not rendered yet.
 * 4. A hard failure with nothing usable to show (`isError` and no cached data) — a plain
 *    recovery page with a retry action. Never the raw error message or a stack (TC-11).
 *
 * Anything else — success, or a background refetch failing while stale data is still on
 * hand — renders the children normally rather than replacing a working screen with an error.
 */
import { type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useBootstrap } from './useBootstrap';

function FullPageSkeleton() {
  return (
    <div
      className="flex min-h-screen animate-pulse flex-col gap-4 bg-slate-50 p-6"
      role="status"
      aria-label="Loading"
    >
      <div className="h-10 w-48 rounded-control bg-slate-200" />
      <div className="flex flex-1 gap-4">
        <div className="h-full w-56 rounded-card bg-slate-200" />
        <div className="h-full flex-1 rounded-card bg-slate-200" />
      </div>
    </div>
  );
}

function BootstrapErrorPage({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-sm rounded-card border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-500">
          We couldn&apos;t load your account. Please try again.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 rounded-control bg-primary px-4 py-2 text-sm font-medium text-white"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export function RequireBootstrap({ children }: { children: ReactNode }) {
  const { isLoading, isError, isUnauthorized, isPasswordChangeRequired, user, refetch } =
    useBootstrap();

  if (isUnauthorized) {
    return null;
  }

  if (isPasswordChangeRequired) {
    return <Navigate to="/change-password" replace />;
  }

  if (isLoading) {
    return <FullPageSkeleton />;
  }

  if (isError && !user) {
    return <BootstrapErrorPage onRetry={refetch} />;
  }

  return <>{children}</>;
}
