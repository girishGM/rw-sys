/**
 * T-031 — `POST/DELETE /rules/:id/countries` (04-FRONTEND.md §4: "Rule country assignment |
 * super_admin | Multi-select countries with a diff preview before save").
 *
 * A diff, not a bulk replace: the two arrays below (`toAssign`/`toUnassign`) are exactly the
 * rows this save actually changes, computed against the currently-assigned set — so the confirm
 * step names the real consequence of the click rather than "N countries selected." Unassigning
 * a country whose campaign is actively bound to this rule 422s (implementation note 6, TC-12);
 * that one row's error is shown inline rather than aborting the whole save, since the other
 * assignment/unassignment calls already succeeded independently.
 */
import { useMemo, useState } from 'react';
import type { Rule } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { MultiSelect, type MultiSelectOption } from '../../components/MultiSelect';
import { Skeleton } from '../../components/Skeleton';
import { useCountriesQuery } from '../countries/api';
import { ApiError } from '../../lib/apiError';
import {
  useAssignRuleCountryMutation,
  useRuleCountriesQuery,
  useUnassignRuleCountryMutation,
} from './api';

export interface AssignCountriesModalProps {
  open: boolean;
  onClose: () => void;
  rule: Rule;
}

interface RowError {
  readonly countryId: number;
  readonly countryLabel: string;
  readonly message: string;
}

export function AssignCountriesModal({ open, onClose, rule }: AssignCountriesModalProps) {
  const countriesQuery = useCountriesQuery({ pageSize: 100, sort: 'name:asc' });
  const assignmentsQuery = useRuleCountriesQuery(rule.id);
  const assignMutation = useAssignRuleCountryMutation(rule.id);
  const unassignMutation = useUnassignRuleCountryMutation(rule.id);

  const [selected, setSelected] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);

  const assignedIds = useMemo(
    () => new Set((assignmentsQuery.data ?? []).map((assignment) => String(assignment.countryId))),
    [assignmentsQuery.data],
  );

  const value = selected ?? [...assignedIds];

  const options: MultiSelectOption[] = (countriesQuery.data?.data ?? []).map((country) => ({
    value: String(country.id),
    label: `${country.name} (${country.code})`,
  }));

  const labelOf = (id: string): string =>
    options.find((option) => option.value === id)?.label ?? id;

  const toAssign = value.filter((id) => !assignedIds.has(id));
  const toUnassign = [...assignedIds].filter((id) => !value.includes(id));

  function handleClose(): void {
    setSelected(null);
    setRowErrors([]);
    onClose();
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setRowErrors([]);
    const errors: RowError[] = [];

    for (const id of toAssign) {
      try {
        await assignMutation.mutateAsync({ countryId: Number(id) });
      } catch (error) {
        errors.push({
          countryId: Number(id),
          countryLabel: labelOf(id),
          message: error instanceof ApiError ? error.message : 'Could not assign this country.',
        });
      }
    }
    for (const id of toUnassign) {
      try {
        await unassignMutation.mutateAsync(Number(id));
      } catch (error) {
        errors.push({
          countryId: Number(id),
          countryLabel: labelOf(id),
          message: error instanceof ApiError ? error.message : 'Could not unassign this country.',
        });
      }
    }

    setSaving(false);
    setRowErrors(errors);
    if (errors.length === 0) handleClose();
  }

  const isLoading = countriesQuery.isLoading || assignmentsQuery.isLoading;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Assign countries — ${rule.ruleCode}`}
      description="Countries selected here can use this rule at campaign time."
    >
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="flex flex-col gap-4">
          <MultiSelect
            label="Countries"
            options={options}
            value={value}
            onChange={(next) => setSelected(next)}
          />

          {(toAssign.length > 0 || toUnassign.length > 0) && (
            <div className="rounded-card border border-slate-200 p-3 text-sm">
              <p className="mb-2 font-medium text-slate-700">Changes to save</p>
              {toAssign.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1">
                  {toAssign.map((id) => (
                    <Badge key={id} tone="success">
                      + {labelOf(id)}
                    </Badge>
                  ))}
                </div>
              )}
              {toUnassign.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {toUnassign.map((id) => (
                    <Badge key={id} tone="danger">
                      − {labelOf(id)}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {rowErrors.length > 0 && (
            <div
              role="alert"
              className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
            >
              <p className="font-medium">Some changes could not be saved:</p>
              <ul className="mt-1 list-disc pl-5">
                {rowErrors.map((rowError) => (
                  <li key={rowError.countryId}>
                    {rowError.countryLabel}: {rowError.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={handleClose}>
              Close
            </Button>
            <Button
              type="button"
              onClick={() => {
                void handleSave();
              }}
              isLoading={saving}
              disabled={toAssign.length === 0 && toUnassign.length === 0}
            >
              Save changes
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
