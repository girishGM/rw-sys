/**
 * T-045 — the trace feature's public surface. `router.tsx` imports `TraceViewerPage` from here;
 * `TraceLink` (and the campaign/approval-request link builders beside it) are the ones other,
 * later features (T-040's audit viewer in particular) are expected to import for the "audit row
 * → trace" half of implementation note 7's cross-links.
 */
export { TraceViewerPage } from './TraceViewerPage';
export { ApprovalRequestLink, CampaignLink, TraceLink } from './components/TraceLink';
export { approvalRequestPath, campaignPath, traceViewerPath } from './components/trace-links';
export { fetchTrace, traceQueryKey } from './api';
