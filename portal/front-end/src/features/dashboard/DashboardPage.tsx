/**
 * T-023 — the role-specific dashboard (04-FRONTEND.md §3), rendered entirely from
 * `useBootstrap().widgets` — no hard-coded widget, no hard-coded layout. Reached at
 * `/dashboard` for every role (`router.tsx`).
 */
import { useMemo } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { useBootstrap } from '../../auth/useBootstrap';
import { WIDGET_REGISTRY } from './widgetRegistry';
import { WidgetBoundary } from './widgets/WidgetBoundary';

export function DashboardPage() {
  const { widgets } = useBootstrap();

  // Looked up once per render rather than inline in the JSX below purely for readability —
  // the lookup itself is a plain object read, not something worth memoising further.
  const entries = useMemo(
    () => widgets.map((widget) => ({ widget, Widget: WIDGET_REGISTRY[widget.key] })),
    [widgets],
  );

  return (
    <div className="p-6">
      <PageHeader title="Dashboard" />

      {entries.length === 0 ? (
        <EmptyState
          message="Nothing to show yet"
          description="Your dashboard has no widgets configured. Ask a Super Admin to add some in Access Control."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {entries.map(({ widget, Widget }) =>
            // 04-FRONTEND.md §3: an unknown `widget_key` renders nothing rather than throwing —
            // one bad config row must never white-screen a whole role's dashboard (TC-10).
            Widget ? (
              <WidgetBoundary key={widget.key} label={widget.label}>
                <Widget label={widget.label} config={widget.config} />
              </WidgetBoundary>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
