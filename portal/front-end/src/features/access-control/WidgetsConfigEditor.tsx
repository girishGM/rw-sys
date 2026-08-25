/**
 * T-033 — the dashboard-widget editor for one role: `GET`/`PUT`/`PATCH .../reorder` of
 * `role_dashboard_widgets`. Same shape as `NavConfigEditor.tsx` — see that file's header for why
 * reordering is Up/Down buttons rather than drag-and-drop. No lock-out rule applies to widgets
 * (implementation note 2 names only the nav entry and two permission cells), so no row here is
 * ever disabled from editing.
 */
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { SharedPortalRole, WidgetConfigItem } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Skeleton } from '../../components/Skeleton';
import { Toggle } from '../../components/Toggle';
import { ApiError } from '../../lib/apiError';
import { usePutWidgetsMutation, useReorderWidgetsMutation, useWidgetsQuery } from './api';

export interface WidgetsConfigEditorProps {
  role: SharedPortalRole;
}

export function WidgetsConfigEditor({ role }: WidgetsConfigEditorProps) {
  const query = useWidgetsQuery(role);
  const putMutation = usePutWidgetsMutation(role);
  const reorderMutation = useReorderWidgetsMutation(role);
  const [items, setItems] = useState<WidgetConfigItem[]>([]);

  useEffect(() => {
    if (query.data) setItems(query.data.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  const dirty = query.data ? JSON.stringify(items) !== JSON.stringify(query.data.items) : false;
  const error = putMutation.error instanceof ApiError ? putMutation.error : null;

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const reordered = [...items];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    const normalised = reordered.map((item, position) => ({
      ...item,
      sortOrder: (position + 1) * 10,
    }));
    setItems(normalised);

    if (!query.data) return;
    reorderMutation.mutate({
      expectedVersion: query.data.version,
      order: normalised.map((item) => ({ key: item.widgetKey, sortOrder: item.sortOrder })),
    });
  }

  function updateItem(index: number, patch: Partial<WidgetConfigItem>): void {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number): void {
    setItems((current) => current.filter((_, i) => i !== index));
  }

  function save(): void {
    if (!query.data) return;
    putMutation.mutate({ expectedVersion: query.data.version, items });
  }

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700">
          {error.code === 'ACCESS_CONTROL_VERSION_CONFLICT'
            ? "This role's dashboard changed elsewhere since you loaded it."
            : error.message}
          {error.code === 'ACCESS_CONTROL_VERSION_CONFLICT' && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="ml-3"
              onClick={() => void query.refetch()}
            >
              Reload latest
            </Button>
          )}
        </p>
      )}

      <ul className="flex flex-col gap-2" aria-label={`Dashboard widgets for ${role}`}>
        {items.map((item, index) => (
          <li
            key={item.widgetKey}
            className="flex items-center gap-3 rounded-control border border-slate-200 p-3"
          >
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={index === 0}
                aria-label={`Move ${item.label} up`}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={index === items.length - 1}
                aria-label={`Move ${item.label} down`}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <Input
              label="Label"
              value={item.label}
              containerClassName="flex-1"
              onChange={(event) => updateItem(index, { label: event.target.value })}
            />
            <Toggle
              label={`Enabled: ${item.label}`}
              hideLabel
              checked={item.enabled}
              onChange={(checked) => updateItem(index, { enabled: checked })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove ${item.label}`}
              onClick={() => removeItem(index)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex justify-end">
        <Button type="button" onClick={save} disabled={!dirty} isLoading={putMutation.isPending}>
          Save dashboard
        </Button>
      </div>
    </div>
  );
}
