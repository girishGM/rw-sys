/**
 * T-042 — `/definition-requests/:id` (06-VERSIONING.md §9's full lifecycle, rendered as one
 * screen: requester detail + edit/withdraw for the requester, triage + fulfil for Super Admin).
 *
 * Every action here is a UX convenience over a guard the server enforces independently
 * (`DefinitionRequestsService`'s three layers) — hiding a button that would 403/409 anyway is
 * the same "the guard is real either way" split every other Wave 3 detail page in this codebase
 * documents (`RuleDetailPage.tsx`, `EditRuleModal.tsx`).
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../components/Input';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { EditDefinitionRequestModal } from './EditDefinitionRequestModal';
import {
  useDefinitionRequestQuery,
  useFulfilDefinitionRequestMutation,
  useReviewDefinitionRequestMutation,
  useWithdrawDefinitionRequestMutation,
} from './api';
import type { DefinitionRequest } from '@reward-portal/shared';

const STATUS_TONE: Record<DefinitionRequest['status'], BadgeTone> = {
  submitted: 'sky',
  under_review: 'warning',
  approved: 'primary',
  rejected: 'danger',
  fulfilled: 'success',
  withdrawn: 'slate',
};

export function DefinitionRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { hasPermission } = useBootstrap();

  const { data: request, isLoading, error } = useDefinitionRequestQuery(id);
  const withdrawMutation = useWithdrawDefinitionRequestMutation(id);
  const reviewMutation = useReviewDefinitionRequestMutation(id);
  const fulfilMutation = useFulfilDefinitionRequestMutation(id);

  const [editOpen, setEditOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [versionId, setVersionId] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const canUpdate = hasPermission('definition_request', 'update');
  const canWithdraw = hasPermission('definition_request', 'withdraw');
  const canReview = hasPermission('definition_request', 'review');
  const canFulfil = hasPermission('definition_request', 'fulfil');

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    );
  }

  if (error || !request) {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-danger-600">
          {error instanceof ApiError ? error.message : 'Could not load this request.'}
        </p>
      </div>
    );
  }

  async function runAction(fn: () => Promise<unknown>): Promise<void> {
    setActionError(null);
    try {
      await fn();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    }
  }

  return (
    <div className="p-6">
      <PageHeader
        title={request.title}
        description={`Definition request #${String(request.id)} — ${request.requestType.replace('_', ' ')}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONE[request.status]}>{request.status.replace('_', ' ')}</Badge>
            {canUpdate && request.status === 'submitted' && (
              <Button type="button" variant="secondary" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            )}
            {canWithdraw && request.status === 'submitted' && (
              <Button type="button" variant="secondary" onClick={() => setWithdrawOpen(true)}>
                Withdraw
              </Button>
            )}
          </div>
        }
      />

      {actionError && (
        <p
          role="alert"
          className="mb-4 rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
        >
          {actionError}
        </p>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900">Details</h2>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-slate-500">Priority</dt>
              <dd className="font-medium text-slate-900">{request.priority}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Entity id</dt>
              <dd className="font-medium text-slate-900">{request.entityId ?? '—'}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-slate-500">Description</dt>
              <dd className="whitespace-pre-wrap text-slate-900">{request.description}</dd>
            </div>
            {request.businessJustification && (
              <div className="col-span-2">
                <dt className="text-slate-500">Business justification</dt>
                <dd className="whitespace-pre-wrap text-slate-900">
                  {request.businessJustification}
                </dd>
              </div>
            )}
            {request.reviewComment && (
              <div className="col-span-2">
                <dt className="text-slate-500">Review comment</dt>
                <dd className="whitespace-pre-wrap text-slate-900">{request.reviewComment}</dd>
              </div>
            )}
            {request.fulfilledVersionId !== null && (
              <div className="col-span-2">
                <dt className="text-slate-500">Fulfilled by version</dt>
                <dd className="font-medium text-slate-900">#{request.fulfilledVersionId}</dd>
              </div>
            )}
          </dl>
        </CardBody>
      </Card>

      {canReview && request.status === 'submitted' && (
        <Card className="mt-4">
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-900">Triage</h2>
          </CardHeader>
          <CardBody>
            <Button
              type="button"
              isLoading={reviewMutation.isPending}
              onClick={() =>
                void runAction(() => reviewMutation.mutateAsync({ status: 'under_review' }))
              }
            >
              Start review
            </Button>
          </CardBody>
        </Card>
      )}

      {canReview && request.status === 'under_review' && (
        <Card className="mt-4">
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-900">Triage</h2>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <div className="flex gap-2">
              <Button
                type="button"
                isLoading={reviewMutation.isPending}
                onClick={() =>
                  void runAction(() => reviewMutation.mutateAsync({ status: 'approved' }))
                }
              >
                Approve
              </Button>
              <Button type="button" variant="danger" onClick={() => setRejectOpen(true)}>
                Reject
              </Button>
            </div>
            {rejectOpen && (
              <div className="flex flex-col gap-2">
                <label htmlFor="reject-comment" className="text-sm font-medium text-slate-700">
                  Reason for rejection (required)
                </label>
                <textarea
                  id="reject-comment"
                  rows={3}
                  value={rejectComment}
                  onChange={(event) => setRejectComment(event.target.value)}
                  className="rounded-control border border-slate-300 px-3 py-2 text-sm"
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="danger"
                    disabled={rejectComment.trim() === ''}
                    isLoading={reviewMutation.isPending}
                    onClick={() =>
                      void runAction(async () => {
                        await reviewMutation.mutateAsync({
                          status: 'rejected',
                          reviewComment: rejectComment,
                        });
                        setRejectOpen(false);
                        setRejectComment('');
                      })
                    }
                  >
                    Confirm rejection
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setRejectOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {canFulfil && request.status === 'approved' && (
        <Card className="mt-4">
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-900">Fulfil</h2>
          </CardHeader>
          <CardBody className="flex items-end gap-2">
            <Input
              label="Published version id"
              hint="The rule/reward version this request is fulfilled by — must already be published."
              value={versionId}
              onChange={(event) => setVersionId(event.target.value)}
            />
            <Button
              type="button"
              disabled={versionId.trim() === ''}
              isLoading={fulfilMutation.isPending}
              onClick={() =>
                void runAction(async () => {
                  await fulfilMutation.mutateAsync({ versionId: Number(versionId) });
                  setVersionId('');
                })
              }
            >
              Fulfil
            </Button>
          </CardBody>
        </Card>
      )}

      <EditDefinitionRequestModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        request={request}
      />

      <ConfirmDialog
        open={withdrawOpen}
        title="Withdraw this request?"
        description="The country/tenant will need to raise a new request if this is still needed."
        confirmLabel="Withdraw"
        variant="destructive"
        isConfirming={withdrawMutation.isPending}
        onConfirm={() =>
          void runAction(async () => {
            await withdrawMutation.mutateAsync();
            setWithdrawOpen(false);
          })
        }
        onCancel={() => setWithdrawOpen(false)}
      />
    </div>
  );
}
