/**
 * T-005 — the mockup's progress track (UI-UX-DESIGN.md "Core components"): 9-10px tall, fully
 * rounded, `--surface-2` track with an `--accent` fill sized to the completed percentage.
 * `Campaign Detail`/`Dashboard` trackers (T-007/T-008) build on this rather than each drawing
 * their own bar.
 */
import { cx } from './internal/cx';

export interface ProgressBarProps {
  /** 0-100. Values outside that range are clamped rather than trusted verbatim, since the
   * caller may be dividing raw progress/threshold numbers that don't self-clamp. */
  value: number;
  /** Accessible label for the underlying `role="progressbar"` element — required, not optional,
   * since a bare percentage means nothing without saying what it's tracking. */
  'aria-label': string;
  className?: string;
  fillClassName?: string;
}

export function ProgressBar({ value, className, fillClassName, ...rest }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value));

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cx('h-2.5 w-full overflow-hidden rounded-full bg-surface-2', className)}
      {...rest}
    >
      <div
        className={cx('h-full rounded-full bg-accent transition-[width]', fillClassName)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
