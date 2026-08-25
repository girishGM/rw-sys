import type { ComponentType, ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cx } from './internal/cx';

export interface EmptyStateProps {
  /** Required — `Table`'s empty state (T-021 TC-6) always shows the caller's message. */
  message: string;
  description?: string;
  icon?: ComponentType<{ className?: string }>;
  action?: ReactNode;
  className?: string;
}

/** T-021 — used directly and as `Table`'s empty-state (0 rows) rendering. */
export function EmptyState({
  message,
  description,
  icon: Icon = Inbox,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center gap-2 px-6 py-12 text-center', className)}>
      <Icon className="size-10 text-slate-300" aria-hidden="true" />
      <p className="text-sm font-medium text-slate-700">{message}</p>
      {description && <p className="max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
