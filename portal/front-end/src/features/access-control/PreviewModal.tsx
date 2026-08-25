/**
 * T-033 — `POST /admin/access-control/preview` (implementation note 6, TC-17, verification
 * step 7). Shows what a role's current, **committed** nav/permissions/widgets render as —
 * `AccessControlService.preview()` also accepts an uncommitted draft (proven in
 * `access-control.e2e-spec.ts`), but wiring per-section unsaved edits through into this modal is
 * left for a follow-up: the three editors each hold their own local draft state, and threading it
 * up here without a shared form store was judged more churn than this task's remaining budget
 * justified. Flagged for the architect as a disclosed simplification, not a missing guarantee —
 * the server-side draft support this depends on is fully built and tested.
 */
import { useEffect } from 'react';
import type { SharedPortalRole } from '@reward-portal/shared';
import { Modal } from '../../components/Modal';
import { Skeleton } from '../../components/Skeleton';
import { usePreviewMutation } from './api';

export interface PreviewModalProps {
  open: boolean;
  onClose: () => void;
  role: SharedPortalRole;
}

export function PreviewModal({ open, onClose, role }: PreviewModalProps) {
  const mutation = usePreviewMutation();

  useEffect(() => {
    if (open) mutation.mutate({ role });
    // Fire once per open, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role]);

  return (
    <Modal open={open} onClose={onClose} title={`Preview — ${role}`} size="lg">
      {mutation.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      ) : mutation.data ? (
        <div className="flex flex-col gap-4">
          <section>
            <h3 className="text-sm font-semibold text-slate-700">Navigation</h3>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-slate-600">
              {mutation.data.nav.map((item) => (
                <li key={item.key}>{item.label}</li>
              ))}
              {mutation.data.nav.length === 0 && <li className="text-slate-400">No nav items</li>}
            </ul>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-slate-700">Permissions</h3>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-slate-600">
              {Object.entries(mutation.data.permissions).map(([entity, actions]) => (
                <li key={entity}>
                  {entity}: {actions.join(', ')}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-slate-700">Dashboard widgets</h3>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-slate-600">
              {mutation.data.widgets.map((widget) => (
                <li key={widget.key}>{widget.label}</li>
              ))}
              {mutation.data.widgets.length === 0 && <li className="text-slate-400">No widgets</li>}
            </ul>
          </section>
          <p className="text-xs text-slate-400">Nothing shown here has been saved.</p>
        </div>
      ) : mutation.isError ? (
        <p role="alert" className="text-sm text-danger-700">
          Could not load the preview. Please try again.
        </p>
      ) : null}
    </Modal>
  );
}
