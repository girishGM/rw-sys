/**
 * T-041 — the "Versions" tab (06-VERSIONING.md §10) embedded in `RuleDetailPage`/
 * `RewardDetailPage`: the version timeline, draft/publish/deprecate/retire actions, the diff
 * viewer, and the entry point into the blast dialog. Every write action here is gated a
 * second, independent time on the server, exactly as `RuleDetailPage.tsx`'s own header
 * documents: hiding a control is UX, not the control.
 */
import { useState } from 'react';
import { Ban, Megaphone, Pencil, Plus } from 'lucide-react';
import type { RewardVersion, RuleVersion } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { BlastDialog } from '../blasts/BlastDialog';
import { EditVersionDraftModal } from './EditVersionDraftModal';
import { VersionDiffViewer } from './VersionDiffViewer';
import {
  useCreateDraftMutation,
  useVersionTransitionMutation,
  useVersionsQuery,
  type VersionEntityType,
} from './api';

export interface VersionsPanelProps {
  entityType: VersionEntityType;
  entityId: number;
  entityLabel: string;
}

const STATUS_TONE: Record<string, 'slate' | 'success' | 'warning' | 'danger'> = {
  draft: 'slate',
  published: 'success',
  deprecated: 'warning',
  retired: 'danger',
};

export function VersionsPanel({ entityType, entityId, entityLabel }: VersionsPanelProps) {
  const { hasPermission } = useBootstrap();
  // No dedicated `version` permission entity (see `versions.constants.ts`'s own header) — the
  // write actions below are Super-Admin-only by role, which `useBootstrap` also exposes.
  const canWrite = hasPermission(entityType, 'create');

  const versionsQuery = useVersionsQuery(entityType, entityId);
  const createDraftMutation = useCreateDraftMutation(entityType, entityId);
  const publishMutation = useVersionTransitionMutation(entityType, entityId, 'publish');
  const deprecateMutation = useVersionTransitionMutation(entityType, entityId, 'deprecate');
  const retireMutation = useVersionTransitionMutation(entityType, entityId, 'retire');

  const [editVersion, setEditVersion] = useState<RuleVersion | RewardVersion | null>(null);
  const [blastVersion, setBlastVersion] = useState<RuleVersion | RewardVersion | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const versions = versionsQuery.data ?? [];
  const hasDraft = versions.some((version) => version.status === 'draft');

  async function handleCreateDraft(): Promise<void> {
    setCreateError(null);
    try {
      await createDraftMutation.mutateAsync({});
    } catch (error) {
      setCreateError(
        error instanceof ApiError ? error.message : 'Could not create a new draft version.',
      );
    }
  }

  async function handlePublish(versionId: number): Promise<void> {
    setActionError(null);
    try {
      await publishMutation.mutateAsync(versionId);
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : 'Could not publish this version.');
    }
  }

  async function handleDeprecate(versionId: number): Promise<void> {
    setActionError(null);
    try {
      await deprecateMutation.mutateAsync(versionId);
    } catch (error) {
      setActionError(
        error instanceof ApiError ? error.message : 'Could not deprecate this version.',
      );
    }
  }

  async function handleRetire(versionId: number): Promise<void> {
    setActionError(null);
    try {
      await retireMutation.mutateAsync(versionId);
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : 'Could not retire this version.');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Version timeline</h2>
          {canWrite && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void handleCreateDraft();
              }}
              isLoading={createDraftMutation.isPending}
              disabled={hasDraft}
              title={hasDraft ? 'A draft already exists — publish or discard it first' : undefined}
            >
              <Plus className="size-4" aria-hidden="true" />
              New draft
            </Button>
          )}
        </CardHeader>
        <CardBody>
          {createError && (
            <p
              role="alert"
              className="mb-3 rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
            >
              {createError}
            </p>
          )}
          {actionError && (
            <p
              role="alert"
              className="mb-3 rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
            >
              {actionError}
            </p>
          )}

          {versionsQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : versionsQuery.isError ? (
            <EmptyState icon={Ban} message="Could not load versions" />
          ) : versions.length === 0 ? (
            <p className="text-sm text-slate-500">No versions yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-1.5">Version</th>
                  <th className="py-1.5">Status</th>
                  <th className="py-1.5">Breaking</th>
                  <th className="py-1.5">Summary</th>
                  <th className="py-1.5">Published</th>
                  <th className="py-1.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td className="py-2 font-medium text-slate-900">v{version.versionNo}</td>
                    <td className="py-2">
                      <Badge tone={STATUS_TONE[version.status] ?? 'slate'}>{version.status}</Badge>
                    </td>
                    <td className="py-2">
                      {version.isBreaking ? <Badge tone="danger">breaking</Badge> : '—'}
                      {version.suggestedIsBreaking === true && !version.isBreaking && (
                        <span className="ml-1 text-xs text-warning-600">(suggested: true)</span>
                      )}
                    </td>
                    <td className="py-2 text-slate-600">{version.changeSummary ?? '—'}</td>
                    <td className="py-2 text-xs text-slate-400">
                      {version.publishedAt
                        ? new Date(version.publishedAt).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="py-2">
                      <div className="flex justify-end gap-1.5">
                        {canWrite && version.status === 'draft' && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditVersion(version)}
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                void handlePublish(version.id);
                              }}
                              isLoading={publishMutation.isPending}
                            >
                              Publish
                            </Button>
                          </>
                        )}
                        {canWrite && version.status === 'published' && (
                          <>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => setBlastVersion(version)}
                            >
                              <Megaphone className="size-4" aria-hidden="true" />
                              Blast
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                void handleDeprecate(version.id);
                              }}
                              isLoading={deprecateMutation.isPending}
                            >
                              Deprecate
                            </Button>
                          </>
                        )}
                        {canWrite && version.status === 'deprecated' && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              void handleRetire(version.id);
                            }}
                            isLoading={retireMutation.isPending}
                          >
                            Retire
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {versions.length >= 2 && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-900">Compare versions</h2>
          </CardHeader>
          <CardBody>
            <VersionDiffViewer entityType={entityType} entityId={entityId} versions={versions} />
          </CardBody>
        </Card>
      )}

      {editVersion && (
        <EditVersionDraftModal
          open={editVersion !== null}
          onClose={() => setEditVersion(null)}
          entityType={entityType}
          entityId={entityId}
          version={editVersion}
        />
      )}

      {blastVersion && (
        <BlastDialog
          open={blastVersion !== null}
          onClose={() => setBlastVersion(null)}
          entityType={entityType}
          entityId={entityId}
          entityLabel={entityLabel}
          version={blastVersion}
        />
      )}
    </div>
  );
}
