import type { ReactNode } from 'react';
import { cx } from './internal/cx';

export interface DescriptionListProps {
  className?: string;
  children: ReactNode;
}

/**
 * T-063 — shared `<dl>` "detail view" convention.
 *
 * Every super_admin/tenant-scoped detail screen (merchant, tenant, country, user, ...) hand-rolled
 * its own `<dl>/<dt>/<dd>` with the same inline class string. That duplication is exactly what let
 * a real WCAG AA contrast failure (`text-xs uppercase tracking-wide text-slate-400`, measured by
 * axe at 2.56:1 against a 4.5:1 requirement — see T-063) repeat across every one of those screens
 * instead of being fixable in one place. New detail views should compose `DescriptionList` +
 * `DescriptionItem` rather than inlining `<dt>`/`<dd>` classes again, so the next fix — contrast,
 * spacing, whatever it is — only has one definition to change.
 */
export function DescriptionList({ className, children }: DescriptionListProps) {
  return <dl className={cx('grid grid-cols-2 gap-4 text-sm', className)}>{children}</dl>;
}

export interface DescriptionItemProps {
  term: ReactNode;
  detail: ReactNode;
  className?: string;
  termClassName?: string;
  detailClassName?: string;
}

/**
 * One `term`/`detail` pair. `slate-600` measures ~7.58:1 on a white `Card` — comfortably past
 * WCAG AA's 4.5:1 for this size/weight — where `slate-400` (the value every screen used to
 * inline) measures only ~2.56:1. Uppercase micro-labels read as harder to see than their raw
 * contrast ratio suggests, so this deliberately doesn't stop at the ~4.76:1 `slate-500` border.
 */
export function DescriptionItem({
  term,
  detail,
  className,
  termClassName,
  detailClassName,
}: DescriptionItemProps) {
  return (
    <div className={className}>
      <dt className={cx('text-xs uppercase tracking-wide text-slate-600', termClassName)}>
        {term}
      </dt>
      <dd className={cx('mt-0.5 text-slate-900', detailClassName)}>{detail}</dd>
    </div>
  );
}
