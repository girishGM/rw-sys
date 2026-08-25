import type { ComponentType, ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cx } from './internal/cx';
import { Skeleton } from './Skeleton';

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  /** Positive shows green + up-arrow, negative red + down-arrow, both with `trendLabel` text. */
  trend?: { direction: 'up' | 'down'; value: string; label?: string };
  isLoading?: boolean;
  className?: string;
}

/** T-021 — dashboard summary tile (04-FRONTEND.md §7). */
export function KpiTile({ label, value, icon: Icon, trend, isLoading, className }: KpiTileProps) {
  return (
    <div
      className={cx(
        'flex flex-col gap-2 rounded-card border border-slate-200 bg-white p-4 shadow-card',
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">{label}</span>
        {Icon && <Icon className="size-4 text-slate-400" aria-hidden="true" />}
      </div>
      {isLoading ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <span className="text-2xl font-semibold text-slate-900">{value}</span>
      )}
      {trend && !isLoading && (
        <span
          className={cx(
            'inline-flex items-center gap-1 text-xs font-medium',
            trend.direction === 'up' ? 'text-success-600' : 'text-danger-600',
          )}
        >
          {trend.direction === 'up' ? (
            <ArrowUp className="size-3" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-3" aria-hidden="true" />
          )}
          {trend.value}
          {trend.label && <span className="font-normal text-slate-500">{trend.label}</span>}
        </span>
      )}
    </div>
  );
}
