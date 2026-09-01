/**
 * T-007 — one of the Dashboard's 3 stat cards (`ARCHITECTURE.md` §4: "summary cards (active
 * campaigns, rewards earned, expiring soon)"), all computed from real `useDashboard` data by the
 * caller — this component only renders whatever number it's given.
 */
import type { ComponentType } from 'react';
import { Card } from '../../components/Card';
import type { IconProps } from '../../components/icons';

export interface StatCardProps {
  icon: ComponentType<IconProps>;
  label: string;
  value: number;
  /** `warn` for the expiring-soon card when it's actually non-zero — same accent/warn tone
   * vocabulary `Badge` uses, so an "attention" stat visually matches the alert banner it's
   * derived from the same count as. */
  tone?: 'accent' | 'warn';
}

export function StatCard({ icon: Icon, label, value, tone = 'accent' }: StatCardProps) {
  return (
    <Card className="flex items-center gap-4 p-5">
      <span
        aria-hidden="true"
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-chip ${
          tone === 'warn' ? 'bg-warn-soft text-warn-strong' : 'bg-accent-soft text-accent-strong'
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="flex flex-col">
        <span className="font-heading text-2xl font-bold text-ink">{value}</span>
        <span className="font-body text-xs font-semibold text-ink-muted">{label}</span>
      </div>
    </Card>
  );
}
