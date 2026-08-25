/**
 * T-023 — the application chrome (04-FRONTEND.md §1): `Sidebar` + `TopBar` around every
 * protected screen. Mounted once, around the whole route tree, by `ProtectedLayout`
 * (`app/routeStubs.tsx`) — it renders only once `RequireBootstrap` has real nav/widget data,
 * so it never has to represent a "loading" state of its own.
 *
 * **T-024 update:** also mounts `<Toaster/>` (`components/Toast.tsx`). `Toast.tsx`'s own file
 * banner already documented this as its home ("mounted once near the app root (`AppShell`,
 * T-023)"), but T-023 never actually added it — a gap this task's own TC-10 ("Change password
 * success: Toast...") needs closed. `layouts/**` is in this agent's file scope across both
 * tasks (T-023 and T-024 are the same owning agent), so this is a same-scope fix rather than an
 * edit to another task's files (AGENT-PROTOCOL R9); flagged in the T-024 completion report.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Toaster } from '../components/Toast';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();

  // A route change is the user's own confirmation the drawer did its job — closing it here
  // means "tap a link, land on the page" rather than "tap a link, then tap again to see it".
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Toaster />
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
