import { useEffect, useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx } from './internal/cx';
import { Portal } from './internal/Portal';
import { useFocusTrap } from './internal/useFocusTrap';
import { useEscapeKey } from './internal/useEscapeKey';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Set false only when the caller provides its own confirming affordance for close. */
  closeOnEscape?: boolean;
}

const SIZE_CLASSES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' };

/**
 * T-021 TC-4 — on open, focus moves inside; `Tab` is trapped; `Esc` closes; focus returns
 * to the trigger on close. Hand-rolled per `internal/useFocusTrap` (see that module's
 * comment for why). `@radix-ui/react-dialog` (^1.1.2) is declared in `package.json` — this
 * is the recommended follow-up swap once this sandbox's lack of network access no longer
 * blocks `npm install` (see the T-021 completion report, "Deviations from spec"); it was not
 * installable when this file was written, and the hand-rolled contract below was re-verified
 * (retry 1/3, 2026-08-18) with a real keyboard/ARIA test suite rather than left on trust.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnEscape = true,
}: ModalProps) {
  const containerRef = useFocusTrap<HTMLDivElement>(open);
  const titleId = useId();
  const descriptionId = useId();

  useEscapeKey(onClose, open && closeOnEscape);

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
        <div
          data-testid="modal-backdrop"
          className="fixed inset-0 bg-slate-900/50"
          aria-hidden="true"
          onClick={onClose}
        />
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          className={cx(
            'relative flex w-full max-h-[90vh] flex-col rounded-card bg-white shadow-popover',
            SIZE_CLASSES[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
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
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className={cx(
                'rounded-control p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
              )}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-6 py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}
