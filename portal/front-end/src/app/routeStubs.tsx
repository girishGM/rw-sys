/**
 * T-020 — placeholder screens used by `router.tsx` for every path no Wave-2/3 task has built
 * yet, plus the layout that runs the guard chain.
 *
 * Split out from `router.tsx` itself so that file can stay free of component declarations —
 * `eslint-plugin-react-refresh`'s `only-export-components` rule (workspace lint gate runs at
 * `--max-warnings=0`) flags a component defined anywhere in a file that also has
 * non-component exports, whether or not that particular component is itself exported. This
 * file exports only components; `router.tsx` exports only route data.
 */
import { type ReactNode } from 'react';
import { BootstrapProvider } from '../auth/BootstrapProvider';
import { RequireAuth } from '../auth/RequireAuth';
import { RequireBootstrap } from '../auth/RequireBootstrap';
import { AppShell } from '../layouts/AppShell';
import { Skeleton } from '../components';
import { ThemeProvider } from './ThemeProvider';

/** A stand-in for every screen no Wave-2/3 task has built yet. Never fetches data itself. */
export function RouteStub({ label }: { label: string }) {
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-slate-900">{label}</h1>
      <p className="mt-1 text-sm text-slate-500">This screen has not been built yet.</p>
    </div>
  );
}

// T-024 — `LoginPlaceholder`/`PublicPlaceholder` (the temporary stand-ins for `/login`,
// `/forgot-password`, `/reset-password`) used to live here. T-024 replaced them outright with
// the real screens in `features/auth/**`; removed rather than left as dead code.

/**
 * T-083 — shown in place of a not-yet-loaded route's content while its chunk downloads, fed to
 * the `Suspense` boundary `router.tsx`'s `buildRouteObjects()` wraps around every lazily-loaded
 * page (see that file's own comment for why the boundary itself lives there and not here).
 * Defined in this file, not `router.tsx`, for the same `only-export-components` reason this
 * file's own header explains: `router.tsx` exports route data, not components, and mixing the
 * two here would break Fast Refresh for it.
 *
 * Distinct `aria-label` from `RequireBootstrap`'s own full-page `role="status"`/`"Loading"`
 * skeleton just above: the two can never be on screen at the same time (this one only ever
 * renders once bootstrap has already resolved and `AppShell` has mounted), but a distinct
 * accessible name keeps the two boundaries unambiguous regardless.
 */
export function RouteChunkFallback() {
  return (
    <div
      className="flex flex-1 items-center justify-center p-6"
      role="status"
      aria-label="Loading page"
    >
      <Skeleton className="h-8 w-40" />
    </div>
  );
}

/**
 * What every protected route mounts under: the whole guard chain, in order, with the T-023
 * chrome (`AppShell` — sidebar, top bar) wrapped around whatever finally clears it. `AppShell`
 * sits *inside* `RequireBootstrap`, not outside it, because it reads real nav/widget data via
 * `useBootstrap()` — it must never render (not even its skeleton-free "no data yet" shape)
 * before that data has actually arrived (04-FRONTEND.md §2: RequireBootstrap "blocks rendering
 * of its children until `/me/bootstrap` has resolved... never flashes a menu... the caller is
 * not entitled to").
 *
 * T-129 — `ThemeProvider` sits in the same spot for the same reason: its own `GET
 * /users/me/preferences` genuinely needs the live session `RequireAuth`/`RequireBootstrap`
 * already guarantee by this point, and `AppShell`'s `TopBar` renders the `ThemeSwitcher` this
 * provider feeds. It re-mounts (and so re-fetches the persisted preference) exactly when this
 * whole layout does — on login, and on a full page reload of any protected route (T-129 TC-2,
 * TC-4) — which is the correct moment for "load the user's saved preference" to mean.
 */
export function ProtectedLayout({ children }: { children: ReactNode }) {
  return (
    <BootstrapProvider>
      <RequireAuth>
        <RequireBootstrap>
          <ThemeProvider>
            <AppShell>{children}</AppShell>
          </ThemeProvider>
        </RequireBootstrap>
      </RequireAuth>
    </BootstrapProvider>
  );
}
