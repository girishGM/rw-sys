/**
 * T-023 — one HTTP call per widget (04-FRONTEND.md implementation note 5: *"Each widget
 * fetches its own scoped data and owns its loading/empty/error states"*), against
 * `GET /dashboard/widgets/:widgetKey`.
 *
 * That route is **not** in 03-API-CONTRACT.md — nothing there describes per-widget dashboard
 * data at all, only the two role-scoped summaries (`GET /countries/:id/summary`,
 * `GET /merchant/summary`) that predate this task. This is this task's own, deliberate
 * addition: implementation note 5 asks for independent per-widget fetches (which is exactly
 * what makes TC-11 — "one widget's API call fails, the rest still render" — true almost by
 * construction, since every tile's `useQuery` is its own request with its own error state), and
 * a single `:widgetKey`-parameterised route is the natural shape for "22 widgets, one call
 * pattern" rather than 22 bespoke endpoints.
 *
 * **T-092 (2026-08-24):** `back-end/src/modules/dashboard` now serves this route — see that
 * module's own header for the full defect history. From T-023 until then, no back end existed
 * for it at all, and every widget tile, for every role, showed its error state against a real
 * running system; nothing in this file changed to fix that (the call shape was always correct),
 * only the server behind it.
 */
import { api } from '../../../lib/apiClient';
import { toApiError } from '../../../lib/apiError';

export function widgetQueryKey(widgetKey: string): readonly [string, string] {
  return ['dashboard-widget', widgetKey] as const;
}

export async function fetchWidgetData<T>(widgetKey: string): Promise<T> {
  try {
    const response = await api.get<{ data: T }>(
      `/dashboard/widgets/${encodeURIComponent(widgetKey)}`,
    );
    return response.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}
