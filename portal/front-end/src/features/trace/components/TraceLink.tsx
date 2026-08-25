/**
 * T-045 implementation note 7 — *"Cross-links both ways: an audit row links to its trace; the
 * trace links back to the campaign, the rule version and the approval request."*
 *
 * The trace's own outbound links (`CampaignLink`, `ApprovalRequestLink`) and the one component
 * every other feature needs for the inbound direction (`<TraceLink correlationId={row
 * .correlationId} />` on an audit row). The route builders these three render are declared in
 * `./trace-links.ts`, a plain (non-component) file — see that file's own header for why the split
 * exists.
 *
 * ### Why "the rule version" is not one of the components below
 *
 * `campaign_audit_trail` rows the trace assembles carry `entityType`/`entityId` — for a
 * `rule_assignment` row, `entityId` is the assignment's own id, not a `rule_versions.id`, and
 * there is no rule-version-specific screen or route yet (T-041, "Version management and blast
 * distribution", has not started; `router.tsx`'s route table has nothing named for one). Linking
 * to a route that does not exist would be worse than omitting the link, so this is a documented
 * gap for T-041 to close by adding its own component here, alongside these two — not a task for
 * T-045 to guess a URL shape for.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { approvalRequestPath, campaignPath, traceViewerPath } from './trace-links';

/**
 * The inbound direction: any audit row (T-040's audit viewer, and this feature's own audit
 * table) links to the trace it belongs to. `null`/`undefined` correlation ids render as plain
 * text — not every audit row carries one (T-019 note 4: outside a request, the column is
 * `NULL`) — a link to nothing is worse than no link.
 */
export function TraceLink({
  correlationId,
  children,
}: {
  correlationId: string | null | undefined;
  children?: ReactNode;
}) {
  if (correlationId === null || correlationId === undefined || correlationId.length === 0) {
    return <span className="text-slate-400">{children ?? '—'}</span>;
  }

  return (
    <Link
      to={traceViewerPath(correlationId)}
      className="font-mono text-xs text-primary-700 underline decoration-dotted underline-offset-2 hover:text-primary-800"
    >
      {children ?? correlationId}
    </Link>
  );
}

export function CampaignLink({
  campaignId,
  children,
}: {
  campaignId: number;
  children?: ReactNode;
}) {
  return (
    <Link
      to={campaignPath(campaignId)}
      className="text-primary-700 underline hover:text-primary-800"
    >
      {children ?? `Campaign #${String(campaignId)}`}
    </Link>
  );
}

export function ApprovalRequestLink({
  approvalRequestId,
  children,
}: {
  approvalRequestId: number;
  children?: ReactNode;
}) {
  return (
    <Link
      to={approvalRequestPath(approvalRequestId)}
      className="text-primary-700 underline hover:text-primary-800"
    >
      {children ?? `Approval #${String(approvalRequestId)}`}
    </Link>
  );
}
