/**
 * T-120 — the Kind selector and its per-kind value editor, shared by `AddRewardModal` and
 * `EditRewardModal` exactly the way `ConnectorConfigEditor.tsx` (T-032) is shared by both today.
 *
 * **The kind → editor map is the extension point.** `KIND_EDITORS` below is a keyed map, not an
 * `if/else` chain, precisely so T-127 can add `PROMO_CODE` by adding one entry here and one entry
 * to `SUPPORTED_REWARD_KINDS` (`rewardValue.ts`) — the task file's implementation note 2. Nothing
 * in this component branches on a specific kind outside that map.
 *
 * Every editor is *additive* to the reward's existing connector/delivery/retry fields
 * (13-REWARD-MASTER-VALUE-SOURCES.md §1: "Existing connector fields ... are **not replaced**") —
 * this component renders below them and knows nothing about them.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { Input } from '../../components/Input';
import { Select, type SelectOption } from '../../components/Select';
import { Toggle } from '../../components/Toggle';
import { useBootstrap } from '../../auth/useBootstrap';
import { useTenantsQuery } from '../tenants/api';
import { PromoCodeValueEditor } from './rewardKindEditors/PromoCodeValueEditor';
import {
  REWARD_KIND_LABELS,
  SUPPORTED_REWARD_KINDS,
  isSupportedRewardKind,
  useTenantCurrenciesQuery,
  type KindEditorProps,
  type RewardValueDraft,
  type SupportedRewardKind,
} from './rewardValue';

const NO_KIND_OPTION: SelectOption = { value: '', label: 'Not set' };

const KIND_OPTIONS: SelectOption[] = [
  NO_KIND_OPTION,
  ...SUPPORTED_REWARD_KINDS.map((kind) => ({ value: kind, label: REWARD_KIND_LABELS[kind] })),
];

// `KindEditorProps` — what every kind editor is handed — moved to `rewardValue.ts` in T-127, so
// that a kind editor living in its own file (`rewardKindEditors/`) can import it without this
// component file exporting a non-component (`react-refresh/only-export-components`, and the
// workspace lints at `--max-warnings=0`).

function FixedAmountEditor({ draft, onChange, currencies, currenciesLoading }: KindEditorProps) {
  const currencyOptions: SelectOption[] = useMemo(
    () => currencies.map((row) => ({ value: row.currencyCode, label: row.currencyCode })),
    [currencies],
  );

  return (
    <div className="flex flex-col gap-3">
      <Toggle
        label="One amount per currency"
        checked={draft.multiCurrency}
        onChange={(checked) => onChange({ ...draft, multiCurrency: checked })}
      />

      {currenciesLoading ? (
        <p className="text-sm text-slate-500">Loading currencies…</p>
      ) : currencies.length === 0 ? (
        <p className="text-sm text-slate-500">
          No active currencies are configured for this tenant yet — add one under Tenants →
          Currencies before setting a fixed amount.
        </p>
      ) : draft.multiCurrency ? (
        // One row per currency the tenant actually supports (T-126), never a hardcoded list.
        // A tenant with exactly one supported currency renders exactly one row (TC-8).
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
              <th className="py-1">Currency</th>
              <th className="py-1">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {currencies.map((row) => (
              <tr key={row.currencyCode}>
                <td className="py-1.5 pr-4 font-mono text-slate-700">{row.currencyCode}</td>
                <td className="py-1.5">
                  <Input
                    label={`Amount in ${row.currencyCode}`}
                    hideLabel
                    inputMode="decimal"
                    placeholder="0.00"
                    value={draft.currencyValues[row.currencyCode] ?? ''}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        currencyValues: {
                          ...draft.currencyValues,
                          [row.currencyCode]: event.target.value,
                        },
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Currency"
            options={currencyOptions}
            value={draft.defaultCurrency === '' ? null : draft.defaultCurrency}
            onChange={(value) => onChange({ ...draft, defaultCurrency: value })}
          />
          <Input
            label="Amount"
            inputMode="decimal"
            placeholder="0.00"
            value={draft.defaultValue}
            onChange={(event) => onChange({ ...draft, defaultValue: event.target.value })}
          />
        </div>
      )}
    </div>
  );
}

function PercentageEditor({ draft, onChange }: KindEditorProps) {
  return (
    <Input
      label="Percentage"
      inputMode="decimal"
      placeholder="5"
      hint="0–100."
      value={draft.percentage}
      onChange={(event) => onChange({ ...draft, percentage: event.target.value })}
    />
  );
}

function PointsEditor({ draft, onChange }: KindEditorProps) {
  return (
    <Input
      label="Points"
      inputMode="numeric"
      placeholder="100"
      value={draft.points}
      onChange={(event) => onChange({ ...draft, points: event.target.value })}
    />
  );
}

function PhysicalEditor({ draft, onChange }: KindEditorProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <Input
        label="SKU"
        placeholder="TSHIRT-BLK-L"
        value={draft.sku}
        onChange={(event) => onChange({ ...draft, sku: event.target.value })}
      />
      <Input
        label="Item description"
        placeholder="Black t-shirt, large"
        value={draft.description}
        onChange={(event) => onChange({ ...draft, description: event.target.value })}
      />
    </div>
  );
}

/**
 * The registry. T-127 added `PROMO_CODE` here — that plus its `SUPPORTED_REWARD_KINDS` entry was
 * the whole change; no call site below reads a kind by name.
 */
const KIND_EDITORS: Record<SupportedRewardKind, (props: KindEditorProps) => ReactElement> = {
  FIXED_AMOUNT: FixedAmountEditor,
  PERCENTAGE: PercentageEditor,
  POINTS: PointsEditor,
  PHYSICAL: PhysicalEditor,
  PROMO_CODE: PromoCodeValueEditor,
};

export interface RewardValueEditorProps {
  readonly draft: RewardValueDraft;
  readonly onChange: (draft: RewardValueDraft) => void;
  /** A validation message for the value as a whole (`buildValueConfig`'s `invalid` branch). */
  readonly error?: string;
}

export function RewardValueEditor({ draft, onChange, error }: RewardValueEditorProps) {
  const { scope } = useBootstrap();

  // Which tenant's supported currencies to offer. A tenant-scoped caller has exactly one answer
  // and is never asked; a `super_admin` (scope.tenantId === null — a global reward belongs to no
  // tenant) picks the currency context explicitly, the same way `AddUserModal` has them pick a
  // tenant rather than inventing one.
  const scopeTenantId = scope?.tenantId ?? null;
  const [pickedTenantId, setPickedTenantId] = useState<number | null>(null);
  const tenantId = scopeTenantId ?? pickedTenantId;

  const needsTenantPicker = scopeTenantId === null && draft.kind === 'FIXED_AMOUNT';
  const tenantsQuery = useTenantsQuery({ pageSize: 100 });
  const currenciesQuery = useTenantCurrenciesQuery(tenantId);

  const tenantOptions: SelectOption[] = useMemo(
    () =>
      (tenantsQuery.data?.data ?? []).map((tenant) => ({
        value: String(tenant.id),
        label: `${tenant.name} (${tenant.code})`,
      })),
    [tenantsQuery.data],
  );

  const KindEditor = draft.kind === '' ? null : KIND_EDITORS[draft.kind];

  return (
    <fieldset className="rounded-control border border-slate-200 p-4">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Kind &amp; value
      </legend>

      <div className="flex flex-col gap-4">
        <Select
          label="Kind"
          options={KIND_OPTIONS}
          value={draft.kind}
          onChange={(value) =>
            onChange({ ...draft, kind: isSupportedRewardKind(value) ? value : '' })
          }
        />

        {needsTenantPicker && (
          <Select
            label="Currency context (tenant)"
            options={tenantOptions}
            value={pickedTenantId === null ? null : String(pickedTenantId)}
            onChange={(value) => setPickedTenantId(value === '' ? null : Number(value))}
            placeholder="Pick a tenant…"
          />
        )}

        {KindEditor !== null && (
          <KindEditor
            draft={draft}
            onChange={onChange}
            currencies={currenciesQuery.data ?? []}
            currenciesLoading={tenantId !== null && currenciesQuery.isLoading}
          />
        )}

        {error !== undefined && (
          <p role="alert" className="text-xs text-danger-600">
            {error}
          </p>
        )}
      </div>
    </fieldset>
  );
}
