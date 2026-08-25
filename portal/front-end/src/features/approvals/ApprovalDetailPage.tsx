/**
 * T-038 — `/approvals/:id`: the approval detail screen (04-FRONTEND.md §4, *"Full payload diff,
 * Approve / Return / Reject with mandatory comment"*).
 *
 * ### The three buttons are rendered from `decidable`, and that is not the control
 *
 * The server computes `decidable` (`actionable && !selfSubmitted && the caller is a checker`) from
 * the verified JWT and ships it as a fact. This screen renders the actions from it, and shows the
 * *reason* when it is false — a checker who submitted the campaign is told so rather than left
 * looking at three greyed-out buttons.
 *
 * None of that is what stops a self-approval. `ApprovalsService` re-derives all three facts inside
 * the decision transaction and answers 422 `SELF_APPROVAL_FORBIDDEN` to a `curl` that never saw a
 * button (T-038 TC-6, TC-17). If this file were deleted the control would be unchanged.
 *
 * ### Nothing here is rendered as HTML
 *
 * Every value on this page — the maker's campaign name, the diff, another checker's review comment
 * — is user-supplied text that reached a database column. All of it is rendered as React children,
 * which escapes it. There is no `dangerouslySetInnerHTML` anywhere in this feature.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ApprovalRequest } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { ApprovalStatusPill } from './ApprovalStatusPill';
import { ApprovalDiffPanel } from './ApprovalDiffPanel';
import { DecisionDialog, type Decision } from './DecisionDialog';
import { useApprovalQuery, useDecideApprovalMutation } from './api';

/** Why the actions are unavailable, in the checker's words rather than the schema's. */
function undecidableReason(request: ApprovalRequest): string | null {
  if (request.selfSubmitted) {
    return 'You submitted this campaign. Segregation of duty means somebody else must review it.';
  }
  if (request.effectiveStatus === 'expired') {
    return 'This request expired before it was reviewed. The maker will need to submit it again.';
  }
  if (!request.actionable) {
    return `This request was already ${request.effectiveStatus}.`;
  }
  return 'Only a checker can decide an approval request.';
}

export function ApprovalDetailPage() {
  const params = useParams<{ id: string }>();
  const approvalId = params.id === undefined ? null : Number(params.id);
  const [decision, setDecision] = useState<Decision | null>(null);

  const { data, isLoading, error } = useApprovalQuery(approvalId);
  const mutation = useDecideApprovalMutation(approvalId ?? 0);

  if (isLoading) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  if (error !== null) {
    return (
      <div className="p-6">
        <EmptyState message="This request is not available" description={error.message} />
      </div>
    );
  }
  if (data === undefined) {
    return (
      <div className="p-6">
        <EmptyState message="This request is not available" />
      </div>
    );
  }

  const { request, diff } = data;
  const reason = request.decidable ? null : undecidableReason(request);

  return (
    <div className="p-6">
      <PageHeader
        title={request.subject === null ? 'Approval request' : request.subject.campaignName}
        description={
          request.subject === null
            ? `Request #${String(request.id)}`
            : `${request.subject.campaignCode} · submitted by ${
                request.requestedByName ?? `user ${String(request.requestedBy)}`
              } on ${new Date(request.requestedAt).toLocaleDateString()}`
        }
        actions={<ApprovalStatusPill status={request.effectiveStatus} />}
      />

      <div className="grid gap-4">
        <Card>
          <CardHeader className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold text-slate-800">Decision</h2>
            {request.subject !== null && (
              <Link
                to={`/campaigns/${String(request.subject.campaignId)}`}
                className="text-sm text-primary-700 underline"
              >
                Open the campaign
              </Link>
            )}
          </CardHeader>
          <CardBody>
            {request.decidable ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    setDecision('approve');
                  }}
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setDecision('return');
                  }}
                >
                  Return for rework
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => {
                    setDecision('reject');
                  }}
                >
                  Reject
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-600">{reason}</p>
            )}

            {request.reviewedAt !== null && (
              <dl className="mt-4 grid gap-1 text-sm text-slate-700">
                <div>
                  <dt className="inline font-medium">Reviewed by: </dt>
                  <dd className="inline">
                    {request.reviewedByName ?? `user ${String(request.reviewedBy ?? 0)}`} on{' '}
                    {new Date(request.reviewedAt).toLocaleString()}
                  </dd>
                </div>
                {request.reviewComment !== null && (
                  <div>
                    <dt className="inline font-medium">Comment: </dt>
                    <dd className="inline">{request.reviewComment}</dd>
                  </div>
                )}
              </dl>
            )}

            <p className="mt-4 text-xs text-slate-500">
              {request.effectiveStatus === 'pending'
                ? `Expires ${new Date(request.expiresAt).toLocaleString()}.`
                : `Expiry was ${new Date(request.expiresAt).toLocaleString()}.`}
            </p>
          </CardBody>
        </Card>

        <ApprovalDiffPanel diff={diff} />
      </div>

      <DecisionDialog
        decision={decision}
        isPending={mutation.isPending}
        error={mutation.error === null ? null : mutation.error.message}
        onClose={() => {
          mutation.reset();
          setDecision(null);
        }}
        onConfirm={(comment) => {
          mutation.mutate(
            { decision: decision as Decision, comment },
            {
              onSuccess: () => {
                setDecision(null);
              },
            },
          );
        }}
      />
    </div>
  );
}
