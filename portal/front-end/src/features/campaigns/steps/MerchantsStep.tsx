/**
 * T-037 step 2 — *"Merchants: pick merchants → their activities become available to components"*
 * (04-FRONTEND.md §5.2).
 *
 * The consequence in that sentence is the reason this step comes second: a component's activity
 * must be offered by one of these merchants (implementation note 8, TC-21h), so step 3 has
 * nothing to offer until this is done. The step says so rather than letting the maker discover it
 * as a validation error two screens later.
 *
 * The list is the tenant's own merchants, from `GET /merchants` — scoped by the server, so this
 * component never filters by tenant itself (TC-13's cross-tenant id is refused by the campaign
 * endpoint regardless of what this list showed).
 */
import { useMemo } from 'react';
import type { CampaignMerchantLink } from '@reward-portal/shared';
import { Card, CardBody } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { MultiSelect } from '../../../components/MultiSelect';
import { useMerchantsQuery } from '../../merchants/api';

export interface MerchantsStepProps {
  readonly selected: readonly CampaignMerchantLink[];
  readonly onChange: (merchantIds: number[]) => void;
  readonly disabled?: boolean;
}

export function MerchantsStep({ selected, onChange, disabled }: MerchantsStepProps) {
  const { data, isLoading } = useMerchantsQuery({ pageSize: 100, sort: 'name:asc' });

  const options = useMemo(
    () =>
      (data?.data ?? []).map((merchant) => ({
        value: String(merchant.id),
        label: `${merchant.name} (${merchant.merchantCode})`,
      })),
    [data],
  );

  const value = selected.map((link) => String(link.merchantId));

  if (!isLoading && options.length === 0) {
    return (
      <EmptyState
        message="No merchants yet"
        description="A campaign needs at least one participating merchant. Ask your Tenant Admin to add one before continuing."
      />
    );
  }

  return (
    <Card>
      <CardBody className="grid gap-4">
        <MultiSelect
          label="Participating merchants"
          options={options}
          value={value}
          disabled={disabled}
          onChange={(next) => {
            onChange(next.map(Number));
          }}
        />
        <p className="text-sm text-slate-500">
          Only activities these merchants offer can be targeted by a journey component in step 3.
        </p>
      </CardBody>
    </Card>
  );
}
