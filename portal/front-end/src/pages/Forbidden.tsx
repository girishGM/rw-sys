/**
 * T-020 — 04-FRONTEND.md §2/§4. Rendered in place by `RequirePermission` (the URL does not
 * change when that happens), and also reachable directly at the standalone route `/403`.
 * Deliberately generic: no mention of which permission was missing, matching
 * 01-DATABASE.md §5.4's rule that the API never leaks internal detail — the UI holds itself
 * to the same standard.
 */
import { Link } from 'react-router-dom';

export function Forbidden() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 px-4 text-center">
      <h1 className="text-lg font-semibold text-slate-900">
        You don&apos;t have access to this page
      </h1>
      <p className="text-sm text-slate-500">
        If you believe this is a mistake, contact your administrator.
      </p>
      <Link to="/dashboard" className="mt-4 text-sm font-medium text-primary underline">
        Back to dashboard
      </Link>
    </div>
  );
}

export default Forbidden;
