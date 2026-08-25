/**
 * T-023 — factory for every `kpi_*` widget (01-DATABASE.md §5.3). One `useQuery`
 * per instance (implementation note 5), rendered with the shared `KpiTile` (T-021) — the
 * design system already owns loading (`isLoading` → `KpiTile`'s own skeleton, TC-18) and
 * value/trend display; this factory owns only the fetch and the error tile (TC-11).
 */
import { useQuery } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import { KpiTile, type KpiTileProps } from '../../../components/KpiTile';
import { fetchWidgetData, widgetQueryKey } from './api';
import { WidgetErrorTile } from './WidgetError';
import type { KpiWidgetData, WidgetProps } from './types';

export interface CreateKpiWidgetOptions {
  readonly icon?: KpiTileProps['icon'];
}

export function createKpiWidget(
  widgetKey: string,
  options: CreateKpiWidgetOptions = {},
): ComponentType<WidgetProps> {
  function KpiWidget({ label }: WidgetProps) {
    const { data, isLoading, isError } = useQuery({
      queryKey: widgetQueryKey(widgetKey),
      queryFn: () => fetchWidgetData<KpiWidgetData>(widgetKey),
    });

    if (isError) {
      return <WidgetErrorTile label={label} />;
    }

    return (
      <KpiTile
        label={label}
        value={data?.value ?? '—'}
        icon={options.icon}
        trend={data?.trend}
        isLoading={isLoading}
      />
    );
  }

  KpiWidget.displayName = `KpiWidget(${widgetKey})`;
  return KpiWidget;
}
