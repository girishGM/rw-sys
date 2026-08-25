import { cx } from './internal/cx';

export interface SkeletonProps {
  className?: string;
}

/**
 * T-021 — content-shaped loading placeholder. §10 (Performance) mandates skeletons over
 * spinners for content areas, for layout stability. Purely decorative (`aria-hidden`) —
 * a region rendering many of these (e.g. `Table`'s skeleton rows) should wrap them in a
 * single `role="status"` announcement rather than one per bar, so assistive tech hears
 * "loading" once instead of N times.
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx('block animate-pulse rounded-control bg-slate-200', className)}
    />
  );
}
