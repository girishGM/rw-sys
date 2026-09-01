/**
 * T-006 — the app shell every route renders inside (`Nav` + the gradient-mesh background + the
 * one app-wide SSE subscription for the currently-selected customer). Split out of `router.tsx`
 * for the same `only-export-components` reason `router.tsx`'s own header explains
 * (`eslint-plugin-react-refresh`'s rule against a non-component export sharing a file with an
 * exported component).
 */
import { Outlet } from 'react-router-dom';
import { Nav } from '../components/Nav';
import { useCustomer } from './useCustomer';
import { useSse } from '../lib/sseClient';

/** The one place `useSse` is mounted app-wide (this task's Scope) — every page just reads the
 * React Query caches this keeps fresh, or listens on `sseBus` for the raw event itself. */
export function Layout() {
  const { customerId } = useCustomer();
  useSse(customerId);

  return (
    <div className="gradient-mesh-bg min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1180px] px-4 py-8 sm:px-8 lg:px-10">
        <Outlet />
      </main>
    </div>
  );
}
