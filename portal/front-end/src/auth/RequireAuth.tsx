/**
 * T-020 — the outermost link of the guard chain (04-FRONTEND.md §2: `<RequireAuth>` →
 * `<RequireBootstrap>` → `<RequireNav path>`).
 *
 * > This is user experience, not security. Anyone can edit client-side state; the server
 * > re-checks every single request (02-SECURITY.md §5). This guard's job is to never show a
 * > user a door that will slam in their face — not to lock the door. Do not assume passing
 * > this check means a request is authorised; the API call it eventually makes is what
 * > actually enforces that.
 *
 * The only signal available is the bootstrap query's own 401 (see `useBootstrap.ts`'s file
 * banner) — there is no separate "is there a session" check to make first. While that query
 * is still in flight this renders its children unconditionally, so the *next* guard down the
 * chain, `RequireBootstrap`, is the one that decides what to show meanwhile (a skeleton,
 * never a flash of real content — TC-2, TC-9).
 */
import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useBootstrap } from './useBootstrap';
import { buildLoginRedirect } from './nextPath';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isUnauthorized } = useBootstrap();
  const location = useLocation();

  if (isUnauthorized) {
    return <Navigate to={buildLoginRedirect(location.pathname, location.search)} replace />;
  }

  return <>{children}</>;
}
