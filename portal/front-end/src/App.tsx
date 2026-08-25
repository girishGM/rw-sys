/**
 * T-001 placeholder shell — proves the build/dev-server/Tailwind pipeline works end to
 * end. T-020 replaces this with the router, auth context and protected routes; T-023
 * replaces the visible content with the data-driven AppShell (04-FRONTEND.md §1, §3).
 */
function App() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="rounded-card border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Reward Portal</h1>
        <p className="mt-1 text-sm text-slate-500">Scaffold — T-020 wires up the real app.</p>
      </div>
    </div>
  );
}

export default App;
