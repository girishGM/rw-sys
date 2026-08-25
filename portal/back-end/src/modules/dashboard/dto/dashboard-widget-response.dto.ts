/**
 * T-092 — the response bodies `GET /dashboard/widgets/:widgetKey` returns.
 *
 * The three shapes below are a **server-side mirror** of
 * `front-end/src/features/dashboard/widgets/types.ts`'s `KpiWidgetData`/`ChartWidgetData`/
 * `ListWidgetData` (T-023) — this route is that file's one and only caller, so the two must
 * agree field-for-field. Declared here rather than imported from the front end because nothing
 * in this codebase shares types across the `back-end`/`front-end` package boundary except
 * `packages/shared`, and a dashboard-tile display shape carries no validation rule worth a Zod
 * schema (03-API-CONTRACT.md never mentions this route at all — `dashboard/widgets/api.ts`'s own
 * header explains why: it is this task's own addition, not a documented contract).
 */

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent every other
 * module's own `*-response.dto.ts` documents: this envelope is an API-wide convention no task
 * owns a shared home for. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

export interface KpiWidgetData {
  readonly value: number | string;
  readonly trend?: {
    readonly direction: 'up' | 'down';
    readonly value: string;
    readonly label?: string;
  };
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

/** The union every resolver in `dashboard.service.ts` returns one member of. */
export type WidgetData = KpiWidgetData | ChartWidgetData | ListWidgetData;

function kpi(value: number | string): KpiWidgetData {
  return { value };
}

function chart(series: readonly ChartWidgetDatum[]): ChartWidgetData {
  return { series };
}

function list(items: readonly ListWidgetItem[]): ListWidgetData {
  return { items };
}

export const toKpiWidgetData = kpi;
export const toChartWidgetData = chart;
export const toListWidgetData = list;
