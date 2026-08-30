/**
 * T-146 — `/rule-value-sources`: Value Sources (registries), a read-only browse screen for the
 * two field value-source registries T-121 already built read APIs for
 * (`GET /field-context-providers`, `GET /field-api-lookup-providers`) but which, until now, were
 * only ever consumed inline by `AddRuleModal.tsx`/`ParameterFieldsEditor.tsx`'s own value-source
 * picker — a Super Admin had no way to browse them on their own, and no nav entry for one.
 *
 * No create/edit/delete here, on purpose — the same reasoning T-108's own header already gives
 * for `/rule-resolvers`/`/rule-operators`: these are seed-managed, rare-change tables, and a CRUD
 * screen here would let someone register a provider with no corresponding runtime handler
 * deployed anywhere.
 */
import type { FieldApiLookupProvider, FieldContextProvider } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Card, CardHeader } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { ApiError } from '../../lib/apiError';
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
  const contextProvidersQuery = useFieldContextProvidersQuery();
  const apiLookupProvidersQuery = useFieldApiLookupProvidersQuery();

  return (
    <div className="p-6">
      <PageHeader
        title="Value Sources"
        description="Context and API lookup providers a rule's parameter fields can point at — read-only reference data."
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-800">Context Providers</h2>
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
          />
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-800">API Lookup Providers</h2>
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
          />
        </Card>
      </div>
    </div>
  );
}
