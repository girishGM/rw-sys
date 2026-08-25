/**
 * T-023 — factory for every `list_*` widget (01-DATABASE.md §5.3). Delegates its four states
 * (loading/error/empty/populated) entirely to the shared `Table` (T-021), which already
 * implements every one of them (TC-18's skeleton rows, TC-11's error row) — this factory's
 * only job is the fetch and the one-column row shape every list widget shares.
 */
import { useQuery } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import { Card, CardBody, CardHeader } from '../../../components/Card';
import { Table } from '../../../components/Table';
import { fetchWidgetData, widgetQueryKey } from './api';
import type { ListWidgetData, ListWidgetItem, WidgetProps } from './types';

export interface CreateListWidgetOptions {
  readonly emptyMessage?: string;
}

export function createListWidget(
  widgetKey: string,
  options: CreateListWidgetOptions = {},
): ComponentType<WidgetProps> {
  function ListWidget({ label }: WidgetProps) {
    const { data, isLoading, isError, error } = useQuery({
      queryKey: widgetQueryKey(widgetKey),
      queryFn: () => fetchWidgetData<ListWidgetData>(widgetKey),
    });

    const items = data?.items ?? [];

    return (
      <Card>
        <CardHeader>
          {/* `h2` — see `ChartWidget.tsx`'s identical comment: the page's one `h1` is
              `PageHeader`'s title, so a widget tile's heading is the next level, not `h3`. */}
          <h2 className="text-sm font-medium text-slate-700">{label}</h2>
        </CardHeader>
        <CardBody>
          <Table<ListWidgetItem>
            caption={label}
            columns={[
              {
                key: 'primary',
                header: 'Item',
                render: (row) => (
                  <div>
                    <div className="font-medium text-slate-800">{row.primary}</div>
                    {row.secondary && <div className="text-xs text-slate-500">{row.secondary}</div>}
                  </div>
                ),
              },
            ]}
            data={[...items]}
            getRowId={(row) => row.id}
            isLoading={isLoading}
            error={isError ? (error.message ?? "Couldn't load this list.") : null}
            emptyMessage={options.emptyMessage ?? 'Nothing to show yet'}
            skeletonRowCount={3}
          />
        </CardBody>
      </Card>
    );
  }

  ListWidget.displayName = `ListWidget(${widgetKey})`;
  return ListWidget;
}
