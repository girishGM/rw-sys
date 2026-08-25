/**
 * T-045 implementation note 7 — the route builders `TraceLink.tsx`'s components render, split
 * into their own plain (`.ts`, not `.tsx`) file so that file exports components only —
 * `eslint-plugin-react-refresh`'s `only-export-components` rule (workspace lint gate runs at
 * `--max-warnings=0`) flags a component file that also exports a non-component value, exactly the
 * reason `routeStubs.tsx`'s own header gives for the same split.
 */

/** `router.tsx`'s own route for the trace viewer — declared once, here, so the controller's own
 * path (`trace.controller.ts`'s `@Controller('audit/trace')`) and the SPA's route never drift
 * apart independently; both are documented against 08-OBSERVABILITY.md §6. */
export function traceViewerPath(correlationId: string): string {
  return `/trace/${encodeURIComponent(correlationId)}`;
}

/** `router.tsx`'s existing `/campaigns/:id` route (`PROTECTED_ROUTE_SPECS`). */
export function campaignPath(campaignId: number): string {
  return `/campaigns/${String(campaignId)}`;
}

/** `router.tsx`'s existing `/approvals/:id` route. */
export function approvalRequestPath(approvalRequestId: number): string {
  return `/approvals/${String(approvalRequestId)}`;
}
