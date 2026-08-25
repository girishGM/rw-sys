/**
 * T-031 — `/rules/:id`: one rule's detail — its expression/parameters, and its country
 * assignments. Every write action here is gated a second, independent time on the server
 * (`RulesController`'s `@RequirePermission`), exactly as `CountryDetailPage.tsx`'s own header
 * documents: hiding a control is UX, not the control.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Ban, Globe2, Pencil, Trash2 } from 'lucide-react';
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
import { AssignCountriesModal } from './AssignCountriesModal';
import { EditRuleModal } from './EditRuleModal';
import { useDeleteRuleMutation, useRuleCountriesQuery, useRuleQuery } from './api';

export function RuleDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { hasPermission } = useBootstrap();
  const canUpdate = hasPermission('rule', 'update');
  const canDelete = hasPermission('rule', 'delete');
  const canAssign = hasPermission('rule_assignment', 'create');

  const [tab, setTab] = useState('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const ruleQuery = useRuleQuery(id);
  const assignmentsQuery = useRuleCountriesQuery(id);
  const deleteMutation = useDeleteRuleMutation();

  if (!Number.isFinite(id)) {
    return (
      <div className="p-6">
        <EmptyState message="Invalid rule id" />
      </div>
    );
  }

  if (ruleQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (ruleQuery.isError || ruleQuery.data === undefined) {
    const message =
      ruleQuery.error instanceof ApiError ? ruleQuery.error.message : 'Could not load this rule.';
    return (
      <div className="p-6">
        <EmptyState icon={Ban} message="Could not load this rule" description={message} />
      </div>
    );
  }

  const rule = ruleQuery.data;

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
          : 'Could not delete this rule. Unassign it from every country first.',
      );
    }
  }

  return (
    <div className="p-6">
      <PageHeader
        title={rule.name}
        description={`${rule.ruleCode} · ${rule.categoryName} / ${rule.subCategoryName}`}
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
        <Badge tone={rule.status === 'active' ? 'success' : 'slate'}>{rule.status}</Badge>
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
                  <h2 className="text-sm font-semibold text-slate-900">Expression</h2>
                </CardHeader>
                <CardBody>
                  <pre className="whitespace-pre-wrap rounded-control bg-slate-50 p-3 font-mono text-sm text-slate-700">
                    {rule.expression ?? '(no expression)'}
                  </pre>
                  <p className="mt-2 text-xs text-slate-500">
                    Stored as inert text — never evaluated by the portal. Passed to the rules engine
                    as-is.
                  </p>
                </CardBody>
              </Card>
            ),
          },
          {
            value: 'parameters',
            label: 'Parameters',
            panel: (
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-slate-900">Parameter schema</h2>
                </CardHeader>
                <CardBody>
                  {rule.parameters.fields.length === 0 ? (
                    <p className="text-sm text-slate-500">This rule takes no dynamic values.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                          <th className="py-1">Key</th>
                          <th className="py-1">Label</th>
                          <th className="py-1">Type</th>
                          <th className="py-1">Required</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rule.parameters.fields.map((field) => (
                          <tr key={field.key}>
                            <td className="py-1.5 font-mono">{field.key}</td>
                            <td className="py-1.5">{field.label}</td>
                            <td className="py-1.5">{field.type}</td>
                            <td className="py-1.5">{field.required ? 'Yes' : 'No'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
            panel: <VersionsPanel entityType="rule" entityId={id} entityLabel={rule.ruleCode} />,
          },
        ]}
      />

      {canUpdate && (
        <EditRuleModal open={editOpen} onClose={() => setEditOpen(false)} rule={rule} />
      )}
      {canAssign && (
        <AssignCountriesModal open={assignOpen} onClose={() => setAssignOpen(false)} rule={rule} />
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={() => {
          void handleDelete();
        }}
        title="Delete this rule?"
        description="A rule still assigned to a country cannot be deleted — unassign it first."
        confirmLabel="Delete"
        variant="destructive"
        isConfirming={deleteMutation.isPending}
      />
    </div>
  );
}
