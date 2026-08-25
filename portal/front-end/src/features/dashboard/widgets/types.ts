/**
 * T-023 — the dashboard widget contract (04-FRONTEND.md §3):
 * `<Widget label={w.label} config={w.widgetConfig} />`. Every entry in `WIDGET_REGISTRY` is a
 * `ComponentType<WidgetProps>` — this is the whole surface a widget component may rely on.
 */
export interface WidgetProps {
  readonly label: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface KpiWidgetData {
  readonly value: number | string;
  readonly trend?: { direction: 'up' | 'down'; value: string; label?: string };
}

export interface ChartWidgetDatum {
  readonly label: string;
  readonly value: number;
}

export interface ChartWidgetData {
  readonly series: readonly ChartWidgetDatum[];
}

export interface ListWidgetItem {
  readonly id: string | number;
  readonly primary: string;
  readonly secondary?: string;
}

export interface ListWidgetData {
  readonly items: readonly ListWidgetItem[];
}
