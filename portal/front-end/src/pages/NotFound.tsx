/**
 * T-020 — 04-FRONTEND.md §2/§4. The catch-all for any path that matches nothing else in the
 * route table (TC-14). It sits inside the same guarded layout route as every real page, so
 * an unauthenticated visitor to a nonsense URL still lands on `/login` (via `RequireAuth`)
 * rather than being told whether the path they guessed happens to be a real route — this
 * component only ever renders for an already-authenticated user.
 */
import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 px-4 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
      <p className="text-sm text-slate-500">The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link to="/dashboard" className="mt-4 text-sm font-medium text-primary underline">
        Back to dashboard
      </Link>
    </div>
  );
}

export default NotFound;
