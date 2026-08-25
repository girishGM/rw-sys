/**
 * T-041 — `/blasts`: blast history (06-VERSIONING.md §10, "Blast history | super_admin,
 * country_admin | Every blast, who, when, which countries, from which request"). A
 * `country_admin` sees only blasts targeting their own country — enforced server-side
 * (`BlastsService.list`'s own header); this screen renders whatever the server returns
 * without narrowing it further.
 *
 * Reached through `/blasts`, behind `router.tsx`'s ordinary `ProtectedLayout` guard chain —
 * but *not* `RequirePermission`: there is no `role_entity_permissions` row for a `blast`
 * entity for any role (`blasts.constants.ts`'s own header explains why), so a permission-table
 * guard would 403 a Super Admin too. This checks the role directly instead, the same static
 * check `@Roles('super_admin', 'country_admin')` makes server-side — the same pattern
 * `TraceViewerPage.tsx` (T-045) already establishes for its own permission-less route.
 */
import { Badge } from '../../components/Badge';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { Forbidden } from '../../pages/Forbidden';
import { ApiError } from '../../lib/apiError';
import { useBlastsQuery, type Blast } from './api';

const SCOPE_LABEL: Record<string, string> = {
  all_countries: 'All countries',
  selected: 'Selected',
};

export function BlastHistoryPage() {
  const { user } = useBootstrap();
  const canView = user?.role === 'super_admin' || user?.role === 'country_admin';
  const blastsQuery = useBlastsQuery({ pageSize: 50 }, canView);

  if (!canView) {
    return <Forbidden />;
  }

  const columns: TableColumn<Blast>[] = [
    {
      key: 'entity',
      header: 'Entity',
      render: (blast) => (
        <span className="capitalize">
          {blast.entityType} #{blast.entityId}
        </span>
      ),
    },
    { key: 'version', header: 'Version', render: (blast) => `v${blast.versionNo}` },
    {
      key: 'scope',
      header: 'Scope',
      render: (blast) => SCOPE_LABEL[blast.scope] ?? blast.scope,
    },
    { key: 'targets', header: 'Countries', render: (blast) => String(blast.targetCount) },
    {
      key: 'targetStatus',
      header: 'Delivery',
      render: (blast) => (
        <div className="flex flex-wrap gap-1">
          {blast.targets.map((target) => (
            <Badge
              key={target.id}
              tone={
                target.status === 'delivered'
                  ? 'success'
                  : target.status === 'failed'
                    ? 'danger'
                    : 'slate'
              }
            >
              {target.countryCode}
            </Badge>
          ))}
        </div>
      ),
    },
    { key: 'note', header: 'Note', render: (blast) => blast.note ?? '—' },
    {
      key: 'blastedAt',
      header: 'Blasted',
      render: (blast) => new Date(blast.blastedAt).toLocaleString(),
    },
  ];

  return (
    <div className="p-6">
      <PageHeader
        title="Blast history"
        description="Every rule/reward version distributed, and to whom."
      />
      <Table
        caption="Blast history"
        columns={columns}
        data={[...(blastsQuery.data?.data ?? [])]}
        getRowId={(blast) => blast.id}
        isLoading={blastsQuery.isLoading}
        error={
          blastsQuery.isError
            ? blastsQuery.error instanceof ApiError
              ? blastsQuery.error.message
              : 'Could not load blast history.'
            : null
        }
        emptyMessage="No blasts yet"
      />
    </div>
  );
}
