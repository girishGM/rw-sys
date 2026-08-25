/**
 * T-034 implementation note 7 / 11-BUDGETS-AND-LIMITS.md §8 — `GET · PUT
 * /tenants/:id/budget-ceilings`, rendered on `TenantDetailPage`.
 *
 * `country_admin` may view **and** set ceilings; every role below (`tenant_admin`, and
 * `super_admin` above it) may only view (TC-23/TC-24 — "a tenant raising its own ceiling defeats
 * the control entirely"). The edit form is hidden entirely for a non-`country_admin` viewer —
 * the same two-independent-controls shape `TenantsListPage.tsx`'s own header documents: hiding
 * the form is the UX half, and `PUT /tenants/:id/budget-ceilings` requiring
 * `tenant_budget_ceiling:update` server-side is the control that actually holds if this check is
 * ever bypassed.
 *
 * `maxCampaignBudget`/`warnAboveAmount` are plain-text inputs, not `type="number"` — the same
 * "money never crosses a boundary as a float" discipline the back end's own model header states;
 * a `<input type="number">` would round-trip the value through a JS `number` on every keystroke.
 */
import { useState, type FormEvent } from 'react';
import type { TenantBudgetCeilingUnitType } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { Input } from '../../components/Input';
import { Select, type SelectOption } from '../../components/Select';
import { Skeleton } from '../../components/Skeleton';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { useBudgetCeilingsQuery, useUpsertBudgetCeilingMutation } from './api';

interface CeilingRow {
  readonly id: number;
  readonly unitType: TenantBudgetCeilingUnitType;
  readonly unitCode: string;
  readonly maxCampaignBudget: string;
  readonly warnAboveAmount: string | null;
}

const UNIT_TYPE_OPTIONS: SelectOption[] = [
  { value: 'currency', label: 'Currency' },
  { value: 'points', label: 'Points' },
  { value: 'voucher', label: 'Voucher' },
];

const COLUMNS: TableColumn<CeilingRow>[] = [
  { key: 'unitType', header: 'Unit type', render: (row) => <Badge>{row.unitType}</Badge> },
  { key: 'unitCode', header: 'Unit code', render: (row) => row.unitCode },
  {
    key: 'maxCampaignBudget',
    header: 'Max campaign budget',
    render: (row) => row.maxCampaignBudget,
  },
  {
    key: 'warnAboveAmount',
    header: 'Warn above',
    render: (row) => row.warnAboveAmount ?? '—',
  },
];

export interface BudgetCeilingsPanelProps {
  tenantId: number;
}

export function BudgetCeilingsPanel({ tenantId }: BudgetCeilingsPanelProps) {
  const { hasPermission } = useBootstrap();
  const canEdit = hasPermission('tenant_budget_ceiling', 'update');

  const ceilingsQuery = useBudgetCeilingsQuery(tenantId);
  const mutation = useUpsertBudgetCeilingMutation(tenantId);

  const [unitType, setUnitType] = useState<TenantBudgetCeilingUnitType>('currency');
  const [unitCode, setUnitCode] = useState('');
  const [maxCampaignBudget, setMaxCampaignBudget] = useState('');
  const [warnAboveAmount, setWarnAboveAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    try {
      await mutation.mutateAsync({
        unitType,
        unitCode,
        maxCampaignBudget,
        warnAboveAmount: warnAboveAmount || undefined,
      });
      setUnitCode('');
      setMaxCampaignBudget('');
      setWarnAboveAmount('');
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Could not save the ceiling.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-slate-900">Budget ceilings</h2>
      </CardHeader>
      <CardBody>
        {ceilingsQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <Table<CeilingRow>
            caption="Budget ceilings"
            columns={COLUMNS}
            data={[...(ceilingsQuery.data ?? [])]}
            getRowId={(row) => row.id}
            isLoading={false}
            error={ceilingsQuery.isError ? 'Could not load budget ceilings.' : null}
            emptyMessage="No budget ceiling configured — this tenant's campaign budgets are unlimited"
          />
        )}

        {canEdit && (
          <form onSubmit={(event) => void onSubmit(event)} className="mt-6 flex flex-col gap-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Set a ceiling
            </h3>
            {formError && (
              <p
                role="alert"
                className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
              >
                {formError}
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Unit type"
                options={UNIT_TYPE_OPTIONS}
                value={unitType}
                onChange={(value) => setUnitType(value as TenantBudgetCeilingUnitType)}
              />
              <Input
                label="Unit code"
                placeholder="MYR"
                value={unitCode}
                onChange={(event) => setUnitCode(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Max campaign budget"
                placeholder="5000000"
                value={maxCampaignBudget}
                onChange={(event) => setMaxCampaignBudget(event.target.value)}
              />
              <Input
                label="Warn above (optional)"
                placeholder="4000000"
                value={warnAboveAmount}
                onChange={(event) => setWarnAboveAmount(event.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" isLoading={mutation.isPending}>
                Save ceiling
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
