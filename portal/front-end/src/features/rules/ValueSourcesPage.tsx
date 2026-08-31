/**
 * T-146 — `/rule-value-sources`: Value Sources (registries), a read-only browse screen for the
 * two field value-source registries T-121 already built read APIs for
 * (`GET /field-context-providers`, `GET /field-api-lookup-providers`) but which, until now, were
 * only ever consumed inline by `AddRuleModal.tsx`/`ParameterFieldsEditor.tsx`'s own value-source
 * picker — a Super Admin had no way to browse them on their own, and no nav entry for one.
 *
 * T-162 — **this screen is no longer read-only.** T-146's own reasoning above (a CRUD screen here
 * "would let someone register a provider with no corresponding runtime handler deployed anywhere")
 * is still true, but the product owner explicitly accepted that residual risk in exchange for the
 * capability (2026-08-31 product report). Add/edit is `super_admin`-only, exactly like every other
 * write on this page's parent nav: hiding the buttons here is UX only (`hasPermission`), the real
 * control is `field-value-source-registries.controller.ts`'s own `@RequirePermission` +
 * `assertRole` pair, which this task did not touch (T-121 already built and gated the write
 * endpoints; see `AddContextProviderModal.tsx`/`AddApiLookupProviderModal.tsx` headers). There is
 * still no delete/deactivate here — out of scope, not an oversight.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { FieldApiLookupProvider, FieldContextProvider } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardHeader } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { AddApiLookupProviderModal } from './AddApiLookupProviderModal';
import { AddContextProviderModal } from './AddContextProviderModal';
import { EditApiLookupProviderModal } from './EditApiLookupProviderModal';
import { EditContextProviderModal } from './EditContextProviderModal';
import { useFieldApiLookupProvidersQuery, useFieldContextProvidersQuery } from './api';

const CONTEXT_COLUMNS: TableColumn<FieldContextProvider>[] = [
  {
    key: 'providerCode',
    header: 'Code',
    render: (row) => <code className="text-xs">{row.providerCode}</code>,
  },
  { key: 'name', header: 'Name', render: (row) => row.name },
  { key: 'description', header: 'Description', render: (row) => row.description ?? '—' },
];

const API_LOOKUP_COLUMNS: TableColumn<FieldApiLookupProvider>[] = [
  {
    key: 'providerCode',
    header: 'Code',
    render: (row) => <code className="text-xs">{row.providerCode}</code>,
  },
  { key: 'name', header: 'Name', render: (row) => row.name },
  {
    key: 'endpoint',
    header: 'Endpoint',
    render: (row) => (
      <code className="text-xs">
        {row.httpMethod} {row.endpointUrl}
      </code>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <Badge tone={row.status === 'active' ? 'success' : 'slate'}>{row.status}</Badge>
    ),
  },
  { key: 'description', header: 'Description', render: (row) => row.description ?? '—' },
];

export function ValueSourcesPage() {
  const { hasPermission } = useBootstrap();
  const contextProvidersQuery = useFieldContextProvidersQuery();
  const apiLookupProvidersQuery = useFieldApiLookupProvidersQuery();

  const canCreateContextProvider = hasPermission('field_context_provider', 'create');
  const canUpdateContextProvider = hasPermission('field_context_provider', 'update');
  const canCreateApiLookupProvider = hasPermission('field_api_lookup_provider', 'create');
  const canUpdateApiLookupProvider = hasPermission('field_api_lookup_provider', 'update');

  const [addContextOpen, setAddContextOpen] = useState(false);
  const [editContextProvider, setEditContextProvider] = useState<FieldContextProvider | null>(null);
  const [addApiLookupOpen, setAddApiLookupOpen] = useState(false);
  const [editApiLookupProvider, setEditApiLookupProvider] = useState<FieldApiLookupProvider | null>(
    null,
  );

  return (
    <div className="p-6">
      <PageHeader
        title="Value Sources"
        description="Context and API lookup providers a rule's parameter fields can point at."
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">Context Providers</h2>
            {canCreateContextProvider && (
              <Button type="button" size="sm" onClick={() => setAddContextOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                Add
              </Button>
            )}
          </CardHeader>
          <Table
            caption="Context providers"
            columns={CONTEXT_COLUMNS}
            data={contextProvidersQuery.data ? [...contextProvidersQuery.data] : []}
            getRowId={(row) => row.id}
            isLoading={contextProvidersQuery.isLoading}
            error={
              contextProvidersQuery.error instanceof ApiError
                ? contextProvidersQuery.error.message
                : null
            }
            emptyMessage="No context providers registered"
            onRowClick={canUpdateContextProvider ? (row) => setEditContextProvider(row) : undefined}
          />
        </Card>
        <Card>
          <CardHeader className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">API Lookup Providers</h2>
            {canCreateApiLookupProvider && (
              <Button type="button" size="sm" onClick={() => setAddApiLookupOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                Add
              </Button>
            )}
          </CardHeader>
          <Table
            caption="API lookup providers"
            columns={API_LOOKUP_COLUMNS}
            data={apiLookupProvidersQuery.data ? [...apiLookupProvidersQuery.data] : []}
            getRowId={(row) => row.id}
            isLoading={apiLookupProvidersQuery.isLoading}
            error={
              apiLookupProvidersQuery.error instanceof ApiError
                ? apiLookupProvidersQuery.error.message
                : null
            }
            emptyMessage="No API lookup providers registered"
            onRowClick={
              canUpdateApiLookupProvider ? (row) => setEditApiLookupProvider(row) : undefined
            }
          />
        </Card>
      </div>

      <AddContextProviderModal open={addContextOpen} onClose={() => setAddContextOpen(false)} />
      {editContextProvider && (
        <EditContextProviderModal
          open
          onClose={() => setEditContextProvider(null)}
          provider={editContextProvider}
        />
      )}
      <AddApiLookupProviderModal
        open={addApiLookupOpen}
        onClose={() => setAddApiLookupOpen(false)}
      />
      {editApiLookupProvider && (
        <EditApiLookupProviderModal
          open
          onClose={() => setEditApiLookupProvider(null)}
          provider={editApiLookupProvider}
        />
      )}
    </div>
  );
}
