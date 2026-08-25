import { cx } from './internal/cx';

/** Campaign statuses per 04-FRONTEND.md §7 — the full, closed set. */
export type CampaignStatus =
  'draft' | 'pending_approval' | 'active' | 'paused' | 'rejected' | 'completed' | 'archived';

const STATUS_CONFIG: Record<CampaignStatus, { label: string; className: string; dot: string }> = {
  draft: { label: 'Draft', className: 'bg-slate-100 text-slate-700', dot: 'bg-slate-500' },
  pending_approval: {
    label: 'Pending approval',
    className: 'bg-warning-100 text-warning-700',
    dot: 'bg-warning-500',
  },
  active: { label: 'Active', className: 'bg-success-100 text-success-700', dot: 'bg-success-500' },
  paused: { label: 'Paused', className: 'bg-sky-100 text-sky-700', dot: 'bg-sky-500' },
  rejected: { label: 'Rejected', className: 'bg-danger-100 text-danger-700', dot: 'bg-danger-500' },
  completed: { label: 'Completed', className: 'bg-slate-100 text-slate-700', dot: 'bg-slate-500' },
  archived: { label: 'Archived', className: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
};

export interface StatusPillProps {
  status: CampaignStatus;
  className?: string;
}

/**
 * T-021 — 04-FRONTEND.md §7: status is always colour **and** text (WCAG 1.4.1 — colour
 * alone is not an accessible signal, and fails colour-blind users). TC-8.
 */
export function StatusPill({ status, className }: StatusPillProps) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        config.className,
        className,
      )}
    >
      <span className={cx('size-1.5 rounded-full', config.dot)} aria-hidden="true" />
      {config.label}
    </span>
  );
}
