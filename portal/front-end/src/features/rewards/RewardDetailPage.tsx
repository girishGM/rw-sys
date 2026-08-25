/**
 * T-032 — `/rewards/:id`: one reward's detail — its connector configuration, policies and
 * country assignments. Every write action here is gated a second, independent time on the
 * server (`RewardsController`'s `@RequirePermission`/`@Roles`), exactly as
 * `RuleDetailPage.tsx`'s own header documents: hiding a control is UX, not the control.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Ban, Globe2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { Tabs } from '../../components/Tabs';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { VersionsPanel } from '../versions';
import { AddPolicyModal } from './AddPolicyModal';
import { AssignCountriesModal } from './AssignCountriesModal';
import { EditRewardModal } from './EditRewardModal';
import {
  useDeleteRewardMutation,
  useRewardCountriesQuery,
  useRewardPoliciesQuery,
  useRewardQuery,
} from './api';

export function RewardDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { hasPermission } = useBootstrap();
  const canUpdate = hasPermission('reward', 'update');
  const canDelete = hasPermission('reward', 'delete');
  const canAssign = hasPermission('reward_assignment', 'create');

  const [tab, setTab] = useState('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [addPolicyOpen, setAddPolicyOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rewardQuery = useRewardQuery(id);
  const assignmentsQuery = useRewardCountriesQuery(id);
  const policiesQuery = useRewardPoliciesQuery(id);
  const deleteMutation = useDeleteRewardMutation();

  if (!Number.isFinite(id)) {
    return (
      <div className="p-6">
        <EmptyState message="Invalid reward id" />
      </div>
    );
  }

  if (rewardQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (rewardQuery.isError || rewardQuery.data === undefined) {
    const message =
      rewardQuery.error instanceof ApiError
        ? rewardQuery.error.message
        : 'Could not load this reward.';
    return (
      <div className="p-6">
        <EmptyState icon={Ban} message="Could not load this reward" description={message} />
      </div>
    );
  }

  const reward = rewardQuery.data;

  async function handleDelete(): Promise<void> {
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(id);
      setConfirmDeleteOpen(false);
      window.history.back();
    } catch (error) {
      setDeleteError(
        error instanceof ApiError
          ? error.message
          : 'Could not delete this reward. Unassign it from every country first.',
      );
    }
  }

  return (
    <div className="p-6">
      <PageHeader
        title={reward.name}
        description={`${reward.systemCode} · ${reward.rewardType} / ${reward.connectorType}`}
        actions={
          <div className="flex gap-2">
            {canAssign && (
              <Button type="button" variant="secondary" onClick={() => setAssignOpen(true)}>
                <Globe2 className="size-4" aria-hidden="true" />
                Assign countries
              </Button>
            )}
            {canUpdate && (
              <Button type="button" variant="secondary" onClick={() => setEditOpen(true)}>
                <Pencil className="size-4" aria-hidden="true" />
                Edit
              </Button>
            )}
            {canDelete && (
              <Button type="button" variant="danger" onClick={() => setConfirmDeleteOpen(true)}>
                <Trash2 className="size-4" aria-hidden="true" />
                Delete
              </Button>
            )}
          </div>
        }
      />

      <div className="flex items-center gap-2 pb-4">
        <Badge tone={reward.status === 'active' ? 'success' : 'slate'}>{reward.status}</Badge>
      </div>

      {deleteError && (
        <p
          role="alert"
          className="mb-4 rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
        >
          {deleteError}
        </p>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          {
            value: 'overview',
            label: 'Overview',
            panel: (
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-slate-900">Connector configuration</h2>
                </CardHeader>
                <CardBody>
                  <dl className="grid grid-cols-2 gap-y-2 text-sm">
                    <dt className="text-slate-500">Delivery mode</dt>
                    <dd className="text-slate-900">{reward.deliveryMode}</dd>
                    <dt className="text-slate-500">Connector type</dt>
                    <dd className="text-slate-900">{reward.connectorType}</dd>
                    <dt className="text-slate-500">Maintenance window</dt>
                    <dd className="text-slate-900">
                      {reward.maintenanceWindowEnabled ? 'Enabled' : 'Disabled'}
                    </dd>
                    <dt className="text-slate-500">Retry</dt>
                    <dd className="text-slate-900">
                      {reward.retryEnabled ? 'Enabled' : 'Disabled'}
                    </dd>
                  </dl>

                  <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Connector config
                  </p>
                  {reward.connectorConfigPreview === null ? (
                    <p className="text-sm text-slate-500">No connector configuration set.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-slate-100">
                        {Object.entries(reward.connectorConfigPreview).map(([key, value]) => (
                          <tr key={key}>
                            <td className="py-1.5 font-mono text-slate-700">{key}</td>
                            <td className="py-1.5 font-mono text-slate-400">{value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="mt-2 text-xs text-slate-500">
                    Values are masked — the plaintext and ciphertext never leave the server
                    (implementation note 4). Use Edit to replace it.
                  </p>
                </CardBody>
              </Card>
            ),
          },
          {
            value: 'policies',
            label: 'Policies',
            panel: (
              <Card>
                <CardHeader className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900">Reward policies</h2>
                  {canUpdate && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setAddPolicyOpen(true)}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                      Add policy
                    </Button>
                  )}
                </CardHeader>
                <CardBody>
                  {policiesQuery.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : (policiesQuery.data ?? []).length === 0 ? (
                    <p className="text-sm text-slate-500">No policies yet.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 text-sm">
                      {(policiesQuery.data ?? []).map((policy) => (
                        <li key={policy.id} className="flex items-center justify-between py-2">
                          <span>
                            {policy.name}{' '}
                            <span className="text-slate-400">({policy.policyCode})</span>
                          </span>
                          <Badge tone={policy.status === 'active' ? 'success' : 'slate'}>
                            {policy.status}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            ),
          },
          {
            value: 'countries',
            label: 'Countries',
            panel: (
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-slate-900">Assigned countries</h2>
                </CardHeader>
                <CardBody>
                  {assignmentsQuery.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : (assignmentsQuery.data ?? []).length === 0 ? (
                    <p className="text-sm text-slate-500">Not assigned to any country yet.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 text-sm">
                      {(assignmentsQuery.data ?? []).map((assignment) => (
                        <li key={assignment.id} className="flex items-center justify-between py-2">
                          <span>
                            {assignment.countryName}{' '}
                            <span className="text-slate-400">({assignment.countryCode})</span>
                          </span>
                          <span className="text-xs text-slate-400">
                            assigned {new Date(assignment.assignedAt).toLocaleDateString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            ),
          },
          {
            value: 'versions',
            label: 'Versions',
            panel: (
              <VersionsPanel entityType="reward" entityId={id} entityLabel={reward.systemCode} />
            ),
          },
        ]}
      />

      {canUpdate && (
        <EditRewardModal open={editOpen} onClose={() => setEditOpen(false)} reward={reward} />
      )}
      {canAssign && (
        <AssignCountriesModal
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          reward={reward}
        />
      )}
      {canUpdate && (
        <AddPolicyModal
          open={addPolicyOpen}
          onClose={() => setAddPolicyOpen(false)}
          rewardId={id}
        />
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={() => {
          void handleDelete();
        }}
        title="Delete this reward?"
        description="A reward still assigned to a country cannot be deleted — unassign it first."
        confirmLabel="Delete"
        variant="destructive"
        isConfirming={deleteMutation.isPending}
      />
    </div>
  );
}
