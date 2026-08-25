import type { ReactNode } from 'react';
import { cx } from './internal/cx';

export type BadgeTone = 'slate' | 'primary' | 'success' | 'warning' | 'danger' | 'sky';

const TONE_CLASSES: Record<BadgeTone, string> = {
  slate: 'bg-slate-100 text-slate-700',
  primary: 'bg-primary-100 text-primary-700',
  success: 'bg-success-100 text-success-700',
  warning: 'bg-warning-100 text-warning-700',
  danger: 'bg-danger-100 text-danger-700',
  sky: 'bg-sky-100 text-sky-700',
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

/** T-021 — small text-plus-colour label; see `StatusPill` for the campaign-status variant. */
export function Badge({ tone = 'slate', children, className }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
