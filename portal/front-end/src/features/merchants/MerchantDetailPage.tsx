/**
 * T-036 — `/merchants/:id`: one merchant's detail, its stores, its activity links, and
 * deactivation.
 *
 * Deactivating a merchant that participates in an active campaign requires explicit confirmation
 * (implementation note 7, TC-20) — this screen surfaces the warning with the actual campaign
 * list (`GET /:id/active-campaigns`) before sending `confirm: true`, the same shape
 * `CountryDetailPage.tsx`'s own summary-driven confirm dialog establishes. Deactivating also
 * revokes every session belonging to this merchant's `merchant`-role users (implementation
 * note 8, TC-20a) — surfaced here explicitly, the same way `TenantDetailPage.tsx`'s suspend
 * dialog discloses its own session-revocation consequence.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Ban, Plus, ShieldOff, Store as StoreIcon } from 'lucide-react';
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
import { AddMerchantActivityModal } from './AddMerchantActivityModal';
import { AddMerchantStoreModal } from './AddMerchantStoreModal';
import {
  useActiveCampaignsQuery,
  useActivitiesQuery,
  useMerchantQuery,
  useStoresQuery,
  useUpdateMerchantMutation,
} from './api';

const STATUS_TONE: Record<string, 'success' | 'slate' | 'warning' | 'danger'> = {
  active: 'success',
  inactive: 'slate',
  suspended: 'danger',
};

export function MerchantDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { hasPermission } = useBootstrap();
  const canUpdate = hasPermission('merchant', 'update');
  const canCreate = hasPermission('merchant', 'create');

  const [tab, setTab] = useState('details');
  const [addStoreOpen, setAddStoreOpen] = useState(false);
  const [addActivityOpen, setAddActivityOpen] = useState(false);
  const [confirmDeactivateOpen, setConfirmDeactivateOpen] = useState(false);

  const merchantQuery = useMerchantQuery(id);
  const storesQuery = useStoresQuery(id);
  const activitiesQuery = useActivitiesQuery(id);
  const activeCampaignsQuery = useActiveCampaignsQuery(id);
  const updateMutation = useUpdateMerchantMutation(id);

  if (!Number.isFinite(id)) {
    return (
      <div className="p-6">
        <EmptyState message="Invalid merchant id" />
      </div>
    );
  }

  if (merchantQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (merchantQuery.isError || merchantQuery.data === undefined) {
    const message =
      merchantQuery.error instanceof ApiError
        ? merchantQuery.error.message
        : 'Could not load this merchant.';
    return (
      <div className="p-6">
        <EmptyState icon={Ban} message="Could not load this merchant" description={message} />
      </div>
    );
  }

  const merchant = merchantQuery.data;
  const activeCampaigns = activeCampaignsQuery.data ?? [];

  function requestDeactivate(): void {
    if (activeCampaigns.length > 0) {
      setConfirmDeactivateOpen(true);
      return;
    }
    updateMutation.mutate({ status: 'inactive' });
  }

  function confirmDeactivate(): void {
    updateMutation.mutate(
      { status: 'inactive', confirm: true },
      { onSuccess: () => setConfirmDeactivateOpen(false) },
    );
  }

  function activate(): void {
    updateMutation.mutate({ status: 'active' });
  }

  return (
    <div className="p-6">
      <PageHeader
        title={merchant.name}
        description={`${merchant.merchantCode} · ${merchant.countryCode}`}
        actions={
          canUpdate && (
            <div className="flex gap-2">
              {merchant.status === 'active' ? (
                <Button
                  type="button"
                  variant="danger"
                  onClick={requestDeactivate}
                  isLoading={updateMutation.isPending}
                >
                  <ShieldOff className="size-4" aria-hidden="true" />
                  Deactivate
                </Button>
              ) : (
                <Button type="button" onClick={activate} isLoading={updateMutation.isPending}>
                  Activate
                </Button>
              )}
            </div>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2 pb-4">
        <Badge tone={STATUS_TONE[merchant.status] ?? 'slate'}>{merchant.status}</Badge>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          {
            value: 'details',
            label: 'Details',
            panel: (
              <Card className="mt-4">
                <CardHeader>
                  <h2 className="text-sm font-semibold text-slate-900">Details</h2>
                </CardHeader>
                <CardBody>
                  <dl className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">
                        Description
                      </dt>
                      <dd className="mt-0.5 text-slate-900">{merchant.description ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">
                        Contact email
                      </dt>
                      <dd className="mt-0.5 text-slate-900">{merchant.contactEmail ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">
                        Contact phone
                      </dt>
                      <dd className="mt-0.5 text-slate-900">{merchant.contactPhone ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Website</dt>
                      <dd className="mt-0.5 text-slate-900">{merchant.website ?? '—'}</dd>
                    </div>
                  </dl>
                </CardBody>
              </Card>
            ),
          },
          {
            value: 'stores',
            label: 'Stores',
            panel: (
              <Card className="mt-4">
                <CardHeader className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900">Stores</h2>
                  {canCreate && (
                    <Button type="button" size="sm" onClick={() => setAddStoreOpen(true)}>
                      <Plus className="size-4" aria-hidden="true" />
                      Add store
                    </Button>
                  )}
                </CardHeader>
                <CardBody>
                  {storesQuery.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : (storesQuery.data ?? []).length === 0 ? (
                    <EmptyState icon={StoreIcon} message="No stores yet" />
                  ) : (
                    <ul className="divide-y divide-slate-100 text-sm">
                      {(storesQuery.data ?? []).map((store) => (
                        <li key={store.id} className="flex items-center justify-between py-2">
                          <span>
                            {store.name}{' '}
                            <span className="text-slate-400">
                              ({store.storeCode}, id {store.id})
                            </span>
                          </span>
                          <Badge tone={store.status === 'active' ? 'success' : 'slate'}>
                            {store.status}
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
            value: 'activities',
            label: 'Activities',
            panel: (
              <Card className="mt-4">
                <CardHeader className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900">Activities</h2>
                  {canCreate && (
                    <Button type="button" size="sm" onClick={() => setAddActivityOpen(true)}>
                      <Plus className="size-4" aria-hidden="true" />
                      Link activity
                    </Button>
                  )}
                </CardHeader>
                <CardBody>
                  {activitiesQuery.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : (activitiesQuery.data ?? []).length === 0 ? (
                    <EmptyState message="No activities linked yet" />
                  ) : (
                    <ul className="divide-y divide-slate-100 text-sm">
                      {(activitiesQuery.data ?? []).map((link) => (
                        <li key={link.id} className="flex items-center justify-between py-2">
                          <span>
                            Activity #{link.activityId}
                            {link.storeId === null
                              ? ' · tenant-wide'
                              : ` · store #${String(link.storeId)}`}
                          </span>
                          <span className="text-slate-500">
                            {link.commissionRate === null ? '—' : `${link.commissionRate}%`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            ),
          },
        ]}
      />

      <AddMerchantStoreModal
        open={addStoreOpen}
        onClose={() => setAddStoreOpen(false)}
        merchantId={id}
      />
      <AddMerchantActivityModal
        open={addActivityOpen}
        onClose={() => setAddActivityOpen(false)}
        merchantId={id}
      />

      <ConfirmDialog
        open={confirmDeactivateOpen}
        onCancel={() => setConfirmDeactivateOpen(false)}
        onConfirm={confirmDeactivate}
        title="Deactivate a merchant with active campaigns?"
        description={`This merchant participates in ${String(
          activeCampaigns.length,
        )} active campaign(s): ${activeCampaigns.map((c) => c.name).join(', ')}. Every session belonging to this merchant's users will be revoked immediately and they will be unable to sign back in until it is reactivated.`}
        confirmLabel="Deactivate anyway"
        variant="destructive"
        isConfirming={updateMutation.isPending}
      />
    </div>
  );
}
