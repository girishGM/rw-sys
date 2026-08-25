import { useEffect, useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx } from './internal/cx';
import { Portal } from './internal/Portal';
import { useFocusTrap } from './internal/useFocusTrap';
import { useEscapeKey } from './internal/useEscapeKey';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  side?: 'left' | 'right';
  width?: 'sm' | 'md' | 'lg';
}

const WIDTH_CLASSES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-xl' };

/**
 * T-021 — same focus-trap/Escape/scroll-lock contract as `Modal` (TC-4), slid in from an
 * edge. Radix has no separate "Drawer" primitive; `@radix-ui/react-dialog` (declared in
 * `package.json`, see `Modal.tsx`) plus a slide transition is the standard way to build one
 * on top of it — the recommended follow-up once network access exists in this sandbox.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  side = 'right',
  width = 'md',
}: DrawerProps) {
  const containerRef = useFocusTrap<HTMLDivElement>(open);
  const titleId = useId();

  useEscapeKey(onClose, open);

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
      <div className="fixed inset-0 z-50 flex">
        <div
          data-testid="drawer-backdrop"
          className="fixed inset-0 bg-slate-900/50"
          aria-hidden="true"
          onClick={onClose}
        />
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={cx(
            'relative flex h-full w-full flex-col bg-white shadow-popover',
            WIDTH_CLASSES[width],
            side === 'right' ? 'ml-auto' : 'mr-auto',
          )}
        >
          <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close panel"
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
