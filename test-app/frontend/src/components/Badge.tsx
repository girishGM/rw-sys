/**
 * T-005 — the mockup's pill/badge (UI-UX-DESIGN.md "Core components"): fully rounded, small
 * bold label. Tone maps directly to that section's 3 named statuses: active/unused =
 * `accent`, ends-soon/expiring = `warn`, used/inactive = `muted`.
 */
import type { ReactNode } from 'react';
import { cx } from './internal/cx';

export type BadgeTone = 'accent' | 'warn' | 'muted';

const TONE_CLASSES: Record<BadgeTone, string> = {
  accent: 'bg-accent-soft text-accent-strong',
  warn: 'bg-warn-soft text-warn-strong',
  muted: 'bg-surface-2 text-ink-muted',
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = 'accent', children, className }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
