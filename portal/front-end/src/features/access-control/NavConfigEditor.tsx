/**
 * T-033 — the nav-config editor for one role: `GET`/`PUT`/`PATCH .../reorder` of
 * `role_nav_configs`.
 *
 * ### Reordering is buttons, not drag-and-drop, and that is a deliberate deviation
 *
 * No drag-and-drop library is in this workspace's dependencies, and adding one is a bigger
 * footprint than a reorder control needs. Up/Down buttons issue the exact same single bulk
 * `PATCH .../reorder` call a drag gesture would (implementation note 7), and — unlike a
 * mouse-only drag surface — they are keyboard- and screen-reader-operable *by construction*,
 * which is what TC-25 asks for ("drag-reorder has a keyboard alternative"). Flagged for the
 * architect: if a drag interaction is wanted in addition, `@dnd-kit` behind the same reorder
 * mutation is the natural follow-up, but the keyboard path must remain regardless.
 *
 * ### Locked row
 *
 * `super_admin`'s own `access_control` row cannot be disabled or removed here — the control is
 * rendered `disabled` with an explanatory `title`, and the server-side guard
 * (`CANNOT_LOCK_OUT_SUPER_ADMIN`) is what actually enforces it (verification step 4: hiding the
 * control is UX, not the control).
 */
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { NavConfigItem, SharedPortalRole } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Skeleton } from '../../components/Skeleton';
import { Toggle } from '../../components/Toggle';
import { ApiError } from '../../lib/apiError';
import { useNavQuery, usePutNavMutation, useReorderNavMutation } from './api';

/** The one row this screen refuses to let a Super Admin disable or remove — see the file header. */
function isLockedRow(role: SharedPortalRole, item: { navKey: string }): boolean {
  return role === 'super_admin' && item.navKey === 'access_control';
}

let nextDraftKey = 0;

export interface NavConfigEditorProps {
  role: SharedPortalRole;
}

export function NavConfigEditor({ role }: NavConfigEditorProps) {
  const query = useNavQuery(role);
  const putMutation = usePutNavMutation(role);
  const reorderMutation = useReorderNavMutation(role);
  const [items, setItems] = useState<NavConfigItem[]>([]);

  useEffect(() => {
    if (query.data) setItems(query.data.items);
    // Re-sync only when the server payload for this role changes, not on every local edit.
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
      order: normalised.map((item) => ({ key: item.navKey, sortOrder: item.sortOrder })),
    });
  }

  function updateItem(index: number, patch: Partial<NavConfigItem>): void {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number): void {
    setItems((current) => current.filter((_, i) => i !== index));
  }

  function addItem(): void {
    nextDraftKey += 1;
    setItems((current) => [
      ...current,
      {
        navKey: `new_item_${String(nextDraftKey)}`,
        label: 'New item',
        icon: null,
        path: '/',
        parentNavKey: null,
        sortOrder: (current.length + 1) * 10,
        enabled: true,
      },
    ]);
  }

  function save(): void {
    if (!query.data) return;
    putMutation.mutate({ expectedVersion: query.data.version, items });
  }

  function reloadLatest(): void {
    void query.refetch();
  }

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-10" />
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
            ? "This role's navigation changed elsewhere since you loaded it."
            : error.message}
          {error.code === 'ACCESS_CONTROL_VERSION_CONFLICT' && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="ml-3"
              onClick={reloadLatest}
            >
              Reload latest
            </Button>
          )}
        </p>
      )}

      <ul className="flex flex-col gap-2" aria-label={`Navigation items for ${role}`}>
        {items.map((item, index) => {
          const locked = isLockedRow(role, item);
          return (
            <li
              key={item.navKey}
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
              <div className="grid flex-1 grid-cols-2 gap-3">
                <Input
                  label="Label"
                  value={item.label}
                  onChange={(event) => updateItem(index, { label: event.target.value })}
                />
                <Input
                  label="Path"
                  value={item.path}
                  onChange={(event) => updateItem(index, { path: event.target.value })}
                />
              </div>
              <Toggle
                label={`Enabled: ${item.label}`}
                hideLabel
                checked={item.enabled}
                disabled={locked}
                onChange={(checked) => updateItem(index, { enabled: checked })}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked}
                title={locked ? 'super_admin must always keep access to Access Control' : undefined}
                aria-label={`Remove ${item.label}`}
                onClick={() => removeItem(index)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="flex justify-between">
        <Button type="button" variant="secondary" onClick={addItem}>
          <Plus className="size-4" aria-hidden="true" />
          Add item
        </Button>
        <Button type="button" onClick={save} disabled={!dirty} isLoading={putMutation.isPending}>
          Save navigation
        </Button>
      </div>
    </div>
  );
}
