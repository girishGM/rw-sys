/**
 * T-023 — factory for every `chart_*` widget (01-DATABASE.md §5.3), wrapping the shared
 * (deliberately thin, T-021) `Chart` component in a labelled `Card` with its own
 * loading/empty/error states.
 */
import { useQuery } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import { Card, CardBody, CardHeader } from '../../../components/Card';
import { Chart } from '../../../components/Chart';
import { EmptyState } from '../../../components/EmptyState';
import { Skeleton } from '../../../components/Skeleton';
import { fetchWidgetData, widgetQueryKey } from './api';
import { WidgetErrorTile } from './WidgetError';
import type { ChartWidgetData, WidgetProps } from './types';

export function createChartWidget(widgetKey: string): ComponentType<WidgetProps> {
  function ChartWidget({ label }: WidgetProps) {
    const { data, isLoading, isError } = useQuery({
      queryKey: widgetQueryKey(widgetKey),
      queryFn: () => fetchWidgetData<ChartWidgetData>(widgetKey),
    });

    if (isError) {
      return <WidgetErrorTile label={label} />;
    }

    return (
      <Card>
        <CardHeader>
          {/* `h2` — the dashboard page has exactly one `h1` (`PageHeader`'s title); a widget
              tile is that page's next heading level, never `h3` (axe `heading-order`). */}
          <h2 className="text-sm font-medium text-slate-700">{label}</h2>
        </CardHeader>
        <CardBody>
          {isLoading ? (
            <div role="status" aria-label={`Loading ${label}`}>
              <Skeleton className="h-40 w-full" />
            </div>
          ) : data && data.series.length > 0 ? (
            <Chart data={[...data.series]} title={label} />
          ) : (
            <EmptyState message="No data yet" />
          )}
        </CardBody>
      </Card>
    );
  }

  ChartWidget.displayName = `ChartWidget(${widgetKey})`;
  return ChartWidget;
}
