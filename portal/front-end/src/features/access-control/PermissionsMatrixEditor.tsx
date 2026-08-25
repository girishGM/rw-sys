/**
 * T-033 — the permission-matrix editor for one role: `GET`/`PUT` of `role_entity_permissions`.
 *
 * Two families of cell are rendered `disabled`, with an explanatory `title` tooltip, matching
 * implementation note 3's *"the UI renders those cells disabled with an explanatory tooltip"*:
 *
 *  - `rule`/`reward` create/update/delete, for every role except `super_admin` — locked to
 *    `super_admin` by both this component and, independently, the server's `PROTECTED_PERMISSION`
 *    guard (TC-13/TC-14).
 *  - `access_control` view/update and `user` create, when editing `super_admin` itself — the
 *    lock-out rule (TC-11). Hiding these controls is UX only; the server's
 *    `CANNOT_LOCK_OUT_SUPER_ADMIN` guard is what actually enforces it.
 */
import { useEffect, useState } from 'react';
import type { SharedPortalRole } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { Skeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/apiError';
import { useEntitiesQuery, usePermissionsQuery, usePutPermissionsMutation } from './api';

const SUPER_ADMIN_REQUIRED: readonly { entity: string; action: string }[] = [
  { entity: 'access_control', action: 'view' },
  { entity: 'access_control', action: 'update' },
  { entity: 'user', action: 'create' },
];

/**
 * T-062 — a rejected save must tell the operator *which field* was rejected, not just show a
 * generic 400 (the task's own implementation note 2). `ApiError.message` alone does not: for a
 * `VALIDATION_FAILED` response `message` is `system_messages`' catalogue text for that *code*, the
 * same string for every validation failure on every screen, and `details[].field` — the one part
 * of the response that actually names the rejected field (`validation.exception-factory.ts`) —
 * was previously never rendered here at all. This is additive to `error.message`, not a
 * replacement for it: PROTECTED_PERMISSION/CANNOT_LOCK_OUT_SUPER_ADMIN (already-covered TC-13/
 * TC-14/TC-11) keep reading exactly as before, since only `VALIDATION_FAILED` carries a
 * `field`-level `details` array in the first place.
 */
function describeError(error: ApiError): string {
  if (error.code === 'ACCESS_CONTROL_VERSION_CONFLICT') {
    return "This role's permissions changed elsewhere since you loaded it.";
  }
  if (error.code === 'VALIDATION_FAILED' && error.details && error.details.length > 0) {
    const fields = [...new Set(error.details.map((detail) => detail.field))];
    return `${error.message} (field${fields.length > 1 ? 's' : ''}: ${fields.join(', ')})`;
  }
  return error.message;
}

function isLockedCell(
  role: SharedPortalRole,
  entity: string,
  action: string,
  protectedActions: readonly string[],
): boolean {
  if (protectedActions.includes(action) && role !== 'super_admin') return true;
  if (role === 'super_admin') {
    return SUPER_ADMIN_REQUIRED.some((cell) => cell.entity === entity && cell.action === action);
  }
  return false;
}

export interface PermissionsMatrixEditorProps {
  role: SharedPortalRole;
}

export function PermissionsMatrixEditor({ role }: PermissionsMatrixEditorProps) {
  const entitiesQuery = useEntitiesQuery();
  const permissionsQuery = usePermissionsQuery(role);
  const putMutation = usePutPermissionsMutation(role);
  const [matrix, setMatrix] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (permissionsQuery.data) setMatrix(permissionsQuery.data.permissions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionsQuery.data]);

  const dirty = permissionsQuery.data
    ? JSON.stringify(sortedMatrix(matrix)) !==
      JSON.stringify(sortedMatrix(permissionsQuery.data.permissions))
    : false;
  const error = putMutation.error instanceof ApiError ? putMutation.error : null;

  function toggle(entity: string, action: string, checked: boolean): void {
    setMatrix((current) => {
      const actions = new Set(current[entity] ?? []);
      if (checked) actions.add(action);
      else actions.delete(action);
      return { ...current, [entity]: [...actions] };
    });
  }

  function save(): void {
    if (!permissionsQuery.data) return;
    putMutation.mutate({ expectedVersion: permissionsQuery.data.version, permissions: matrix });
  }

  if (entitiesQuery.isLoading || permissionsQuery.isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700">
          {describeError(error)}
          {error.code === 'ACCESS_CONTROL_VERSION_CONFLICT' && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="ml-3"
              onClick={() => void permissionsQuery.refetch()}
            >
              Reload latest
            </Button>
          )}
        </p>
      )}

      <div className="overflow-x-auto rounded-card border border-slate-200">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Permission matrix for {role}</caption>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th scope="col" className="px-4 py-2.5 text-left font-medium text-slate-600">
                Entity
              </th>
              <th scope="col" className="px-4 py-2.5 text-left font-medium text-slate-600">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {(entitiesQuery.data ?? []).map((entry) => {
              const granted = new Set(matrix[entry.entity] ?? []);
              return (
                <tr key={entry.entity} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-4 py-3 font-medium text-slate-700">{entry.entity}</td>
                  <td className="flex flex-wrap gap-4 px-4 py-3">
                    {entry.actions.map((action) => {
                      const locked = isLockedCell(
                        role,
                        entry.entity,
                        action,
                        entry.protectedActions,
                      );
                      return (
                        <Checkbox
                          key={action}
                          label={action}
                          checked={granted.has(action)}
                          disabled={locked}
                          title={
                            locked
                              ? entry.protectedActions.includes(action) && role !== 'super_admin'
                                ? `${entry.entity}:${action} is reserved for super_admin`
                                : 'super_admin must always keep this permission'
                              : undefined
                          }
                          onChange={(event) => toggle(entry.entity, action, event.target.checked)}
                        />
                      );
                    })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <Button type="button" onClick={save} disabled={!dirty} isLoading={putMutation.isPending}>
          Save permissions
        </Button>
      </div>
    </div>
  );
}

function sortedMatrix(matrix: Record<string, readonly string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const key of Object.keys(matrix).sort()) {
    const actions = matrix[key];
    if (actions.length > 0) result[key] = [...actions].sort();
  }
  return result;
}
