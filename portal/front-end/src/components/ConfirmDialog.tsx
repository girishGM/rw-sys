import { useEffect, useId, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Portal } from './internal/Portal';
import { useFocusTrap } from './internal/useFocusTrap';
import { useEscapeKey } from './internal/useEscapeKey';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger styling on the confirm action; still defaults focus to Cancel either way. */
  variant?: 'default' | 'destructive';
  isConfirming?: boolean;
}

/**
 * T-021 TC-11 — a destructive confirm that defaults focus to Confirm turns a stray Enter
 * keypress into data loss, so this **always** focuses Cancel on open, regardless of
 * variant — the Cancel button is rendered first and passed as `initialFocusRef`.
 */
export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  isConfirming = false,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const containerRef = useFocusTrap<HTMLDivElement>(open, cancelRef);
  const titleId = useId();
  const descriptionId = useId();

  useEscapeKey(onCancel, open);

  useEffect(() => {
    if (!open) return undefined;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  if (!open) return null;

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="fixed inset-0 bg-slate-900/50" aria-hidden="true" />
        <div
          ref={containerRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          className="relative flex w-full max-w-sm flex-col gap-4 rounded-card bg-white p-6 shadow-popover"
        >
          <div className="flex items-start gap-3">
            {variant === 'destructive' && (
              <AlertTriangle
                className="mt-0.5 size-5 shrink-0 text-danger-600"
                aria-hidden="true"
              />
            )}
            <div>
              <h2 id={titleId} className="text-base font-semibold text-slate-900">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-slate-500">
                  {description}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              variant={variant === 'destructive' ? 'danger' : 'primary'}
              onClick={onConfirm}
              isLoading={isConfirming}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
