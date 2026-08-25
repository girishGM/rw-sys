/**
 * T-035 — `/users/:id`: one user's detail, deactivation and admin-initiated password reset.
 *
 * Implementation note 6 / TC-23: "a user may never deactivate themselves" — the Deactivate
 * action is hidden outright when the viewed row is the signed-in actor's own (`user.id ===
 * row.id`), the same "hiding is UX, the server is the control" shape every other write action in
 * this portal follows: `UsersService.deactivate()` refuses the same case with 422
 * `CANNOT_DEACTIVATE_SELF` regardless of what this screen shows.
 *
 * T-046: the reset-password result now renders through `PasswordRevealPanel`, which owns its own
 * gated dismiss (implementation note 8, TC-20) — `onDismiss` here just clears `resetResult`.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Ban, KeyRound, ShieldOff } from 'lucide-react';
import type { UserWithTemporaryPassword } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { PasswordRevealPanel } from './PasswordRevealPanel';
import { useDeactivateUserMutation, useResetUserPasswordMutation, useUserQuery } from './api';

const STATUS_TONE: Record<string, 'success' | 'slate' | 'warning' | 'danger'> = {
  pending_activation: 'warning',
  active: 'success',
  inactive: 'slate',
  locked: 'danger',
  suspended: 'danger',
};

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  country_admin: 'Country Admin',
  tenant_admin: 'Tenant Admin',
  maker: 'Maker',
  checker: 'Checker',
  merchant: 'Merchant',
};

export function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { user: actor, hasPermission } = useBootstrap();
  const canUpdate = hasPermission('user', 'update');

  const [confirmDeactivateOpen, setConfirmDeactivateOpen] = useState(false);
  const [resetResult, setResetResult] = useState<UserWithTemporaryPassword | null>(null);

  const userQuery = useUserQuery(id);
  const deactivateMutation = useDeactivateUserMutation(id);
  const resetMutation = useResetUserPasswordMutation(id);

  if (!Number.isFinite(id)) {
    return (
      <div className="p-6">
        <EmptyState message="Invalid user id" />
      </div>
    );
  }

  if (userQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (userQuery.isError || userQuery.data === undefined) {
    const message =
      userQuery.error instanceof ApiError ? userQuery.error.message : 'Could not load this user.';
    return (
      <div className="p-6">
        <EmptyState icon={Ban} message="Could not load this user" description={message} />
      </div>
    );
  }

  const targetUser = userQuery.data;
  const isSelf = actor !== undefined && actor.id === targetUser.id;

  function deactivate(): void {
    deactivateMutation.mutate(undefined, { onSuccess: () => setConfirmDeactivateOpen(false) });
  }

  async function resetPassword(): Promise<void> {
    const result = await resetMutation.mutateAsync();
    setResetResult(result);
  }

  return (
    <div className="p-6">
      <PageHeader
        title={targetUser.displayName}
        description={targetUser.email}
        actions={
          canUpdate && (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void resetPassword()}
                isLoading={resetMutation.isPending}
              >
                <KeyRound className="size-4" aria-hidden="true" />
                Reset password
              </Button>
              {!isSelf && targetUser.status === 'active' && (
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => setConfirmDeactivateOpen(true)}
                  isLoading={deactivateMutation.isPending}
                >
                  <ShieldOff className="size-4" aria-hidden="true" />
                  Deactivate
                </Button>
              )}
            </div>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2 pb-4">
        <Badge tone={STATUS_TONE[targetUser.status] ?? 'slate'}>{targetUser.status}</Badge>
        <Badge tone="slate">{ROLE_LABELS[targetUser.role] ?? targetUser.role}</Badge>
      </div>

      {resetResult && (
        <div className="mb-4">
          <PasswordRevealPanel
            email={resetResult.email}
            temporaryPassword={resetResult.temporaryPassword}
            action="reset"
            onDismiss={() => setResetResult(null)}
          />
        </div>
      )}

      <Card className="mb-4">
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900">Details</h2>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Country</dt>
              <dd className="mt-0.5 text-slate-900">{targetUser.countryId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Tenant</dt>
              <dd className="mt-0.5 text-slate-900">{targetUser.tenantId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Merchant</dt>
              <dd className="mt-0.5 text-slate-900">{targetUser.merchantId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">
                Must change password
              </dt>
              <dd className="mt-0.5 text-slate-900">
                {targetUser.mustChangePassword ? 'Yes' : 'No'}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmDeactivateOpen}
        onCancel={() => setConfirmDeactivateOpen(false)}
        onConfirm={deactivate}
        title="Deactivate this user?"
        description="They will be logged out immediately and unable to sign back in until reactivated."
        confirmLabel="Deactivate anyway"
        variant="destructive"
        isConfirming={deactivateMutation.isPending}
      />
    </div>
  );
}
