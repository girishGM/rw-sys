/**
 * T-041 — implementation note 8: "Diff view compares `expression` and `parameters` between two
 * versions, highlighting parameter additions/removals/type changes." Two pickers + the result,
 * inline rather than a modal — a Super Admin comparing versions typically wants to keep the
 * version list visible alongside it.
 */
import { useState } from 'react';
import type { RewardVersion, RuleVersion } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Select, type SelectOption } from '../../components/Select';
import { Skeleton } from '../../components/Skeleton';
import { useVersionDiffQuery, type VersionEntityType } from './api';

export interface VersionDiffViewerProps {
  entityType: VersionEntityType;
  entityId: number;
  versions: readonly (RuleVersion | RewardVersion)[];
}

export function VersionDiffViewer({ entityType, entityId, versions }: VersionDiffViewerProps) {
  const options: SelectOption[] = versions.map((version) => ({
    value: String(version.id),
    label: `v${String(version.versionNo)} (${version.status})`,
  }));

  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);

  const diffQuery = useVersionDiffQuery(
    entityType,
    entityId,
    fromId === null ? null : Number(fromId),
    toId === null ? null : Number(toId),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Compare"
          options={options}
          value={fromId}
          onChange={setFromId}
          placeholder="From version"
        />
        <Select
          label="Against"
          options={options}
          value={toId}
          onChange={setToId}
          placeholder="To version"
        />
      </div>

      {diffQuery.isLoading && <Skeleton className="h-24 w-full" />}

      {diffQuery.data && (
        <div className="rounded-card border border-slate-200 p-4 text-sm">
          <div className="mb-3 flex items-center gap-2">
            <span className="font-medium text-slate-700">Expression changed:</span>
            <Badge tone={diffQuery.data.expressionChanged ? 'warning' : 'slate'}>
              {diffQuery.data.expressionChanged ? 'Yes' : 'No'}
            </Badge>
            <span className="ml-4 font-medium text-slate-700">Suggested is_breaking:</span>
            <Badge tone={diffQuery.data.suggestedIsBreaking ? 'danger' : 'success'}>
              {diffQuery.data.suggestedIsBreaking ? 'true' : 'false'}
            </Badge>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Added
              </p>
              {diffQuery.data.parametersAdded.length === 0 ? (
                <p className="text-slate-400">—</p>
              ) : (
                <ul className="space-y-1">
                  {diffQuery.data.parametersAdded.map((key) => (
                    <li key={key}>
                      <Badge tone="success">+ {key}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Removed
              </p>
              {diffQuery.data.parametersRemoved.length === 0 ? (
                <p className="text-slate-400">—</p>
              ) : (
                <ul className="space-y-1">
                  {diffQuery.data.parametersRemoved.map((key) => (
                    <li key={key}>
                      <Badge tone="danger">− {key}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Type changed
              </p>
              {diffQuery.data.parametersTypeChanged.length === 0 ? (
                <p className="text-slate-400">—</p>
              ) : (
                <ul className="space-y-1">
                  {diffQuery.data.parametersTypeChanged.map((key) => (
                    <li key={key}>
                      <Badge tone="warning">~ {key}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
