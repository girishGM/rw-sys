/**
 * T-041 — the blast dialog (06-VERSIONING.md §6/§10): "All countries vs selected; preview of
 * who gains what; breaking-change warning." Implementation note 6 makes preview **mandatory**
 * before a real blast in the UI — this component enforces that structurally: the "Confirm
 * blast" action does not even render until a preview response exists for the current
 * scope/country selection.
 */
import { useState } from 'react';
import type { RewardVersion, RuleVersion } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { MultiSelect, type MultiSelectOption } from '../../components/MultiSelect';
import { RadioGroup } from '../../components/Radio';
import { Skeleton } from '../../components/Skeleton';
import { useCountriesQuery } from '../countries/api';
import { ApiError } from '../../lib/apiError';
import type { VersionEntityType } from '../versions/api';
import { useCreateBlastMutation, usePreviewBlastMutation } from './api';

export interface BlastDialogProps {
  open: boolean;
  onClose: () => void;
  entityType: VersionEntityType;
  entityId: number;
  entityLabel: string;
  version: RuleVersion | RewardVersion;
}

type Scope = 'all_countries' | 'selected';

export function BlastDialog({
  open,
  onClose,
  entityType,
  entityId,
  entityLabel,
  version,
}: BlastDialogProps) {
  const countriesQuery = useCountriesQuery({ pageSize: 100, sort: 'name:asc' });
  const previewMutation = usePreviewBlastMutation();
  const createMutation = useCreateBlastMutation();

  const [scope, setScope] = useState<Scope>('selected');
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [confirmBreaking, setConfirmBreaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countryOptions: MultiSelectOption[] = (countriesQuery.data?.data ?? []).map((country) => ({
    value: String(country.id),
    label: `${country.name} (${country.code})`,
  }));

  function handleClose(): void {
    setScope('selected');
    setSelectedCountries([]);
    setNote('');
    setConfirmBreaking(false);
    setError(null);
    previewMutation.reset();
    onClose();
  }

  async function handlePreview(): Promise<void> {
    setError(null);
    try {
      await previewMutation.mutateAsync({
        entityType,
        entityId,
        versionId: version.id,
        scope,
        countryIds: scope === 'selected' ? selectedCountries.map(Number) : undefined,
      });
    } catch (previewError) {
      setError(
        previewError instanceof ApiError ? previewError.message : 'Could not preview this blast.',
      );
    }
  }

  async function handleConfirm(): Promise<void> {
    setError(null);
    try {
      await createMutation.mutateAsync({
        entityType,
        entityId,
        versionId: version.id,
        scope,
        countryIds: scope === 'selected' ? selectedCountries.map(Number) : undefined,
        note: note === '' ? undefined : note,
        confirmBreaking: version.isBreaking ? confirmBreaking : undefined,
      });
      handleClose();
    } catch (confirmError) {
      setError(
        confirmError instanceof ApiError ? confirmError.message : 'Could not complete this blast.',
      );
    }
  }

  const preview = previewMutation.data;
  const canConfirm =
    preview !== undefined && (!preview.isBreaking || confirmBreaking) && !createMutation.isPending;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Blast ${entityLabel} v${String(version.versionNo)}`}
      description="Preview is mandatory — see who gains what before distributing to any country."
      size="lg"
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p
            role="alert"
            className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
          >
            {error}
          </p>
        )}

        <RadioGroup
          name="blast-scope"
          label="Scope"
          orientation="horizontal"
          value={scope}
          onChange={(next) => {
            setScope(next as Scope);
            previewMutation.reset();
          }}
          options={[
            { value: 'selected', label: 'Selected countries' },
            { value: 'all_countries', label: 'All active countries' },
          ]}
        />

        {scope === 'selected' &&
          (countriesQuery.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <MultiSelect
              label="Countries"
              options={countryOptions}
              value={selectedCountries}
              onChange={(next) => {
                setSelectedCountries(next);
                previewMutation.reset();
              }}
            />
          ))}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="blast-note" className="text-sm font-medium text-slate-700">
            Note (optional)
          </label>
          <input
            id="blast-note"
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="rounded-control border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
          />
        </div>

        <div className="flex justify-start">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void handlePreview();
            }}
            isLoading={previewMutation.isPending}
            disabled={scope === 'selected' && selectedCountries.length === 0}
          >
            Preview
          </Button>
        </div>

        {preview && (
          <div className="rounded-card border border-slate-200 p-4 text-sm">
            <div className="mb-3 flex items-center gap-2">
              <span className="font-medium text-slate-700">This version is:</span>
              <Badge tone={preview.isBreaking ? 'danger' : 'success'}>
                {preview.isBreaking ? 'breaking' : 'not breaking'}
              </Badge>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-1">Country</th>
                  <th className="py-1">Holds now</th>
                  <th className="py-1">Will hold</th>
                  <th className="py-1">Active campaigns on current</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.countries.map((impact) => (
                  <tr key={impact.countryId}>
                    <td className="py-1.5">
                      {impact.countryName}{' '}
                      <span className="text-slate-400">({impact.countryCode})</span>
                    </td>
                    <td className="py-1.5">
                      {impact.currentVersionNo === null
                        ? '—'
                        : `v${String(impact.currentVersionNo)}`}
                    </td>
                    <td className="py-1.5 font-medium text-slate-900">
                      v{impact.willReceiveVersionNo}
                    </td>
                    <td className="py-1.5">{impact.activeCampaignsOnCurrentVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {preview.isBreaking && (
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={confirmBreaking}
                  onChange={(event) => setConfirmBreaking(event.target.checked)}
                  className="size-4 rounded border-slate-300 text-primary-600"
                />
                I understand this is a breaking change and confirm the blast.
              </label>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void handleConfirm();
            }}
            isLoading={createMutation.isPending}
            disabled={!canConfirm}
          >
            Confirm blast
          </Button>
        </div>
      </div>
    </Modal>
  );
}
