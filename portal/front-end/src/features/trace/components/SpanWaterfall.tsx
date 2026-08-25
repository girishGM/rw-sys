/**
 * T-045 — the §5 waterfall (08-OBSERVABILITY.md §5), rendered as an accessible table rather than
 * a bare bar chart: every value that matters (name, start, duration, status) exists as real text
 * in a table cell, and the horizontal bar beside it is `aria-hidden` decoration on top of that,
 * never the only carrier of the information (WCAG 1.4.1 — the same rule `StatusPill` follows for
 * colour).
 *
 * Implementation note 6 — *"slow spans (> 25% of total) highlighted"* — is already decided by the
 * server (`TraceSpan.slow`, `trace-assembly.ts`'s `SLOW_SPAN_RATIO`); this component only renders
 * the flag, it does not recompute the threshold, so the one number that matters has one owner.
 */
import { AlertTriangle } from 'lucide-react';
import type { TraceSpan } from '@reward-portal/shared';
import { Badge } from '../../../components/Badge';
import { EmptyState } from '../../../components/EmptyState';

export interface SpanWaterfallProps {
  spans: readonly TraceSpan[];
  /** The request's own total duration, for scaling each bar. `null` → bars render at 0 width. */
  totalDurationMs: number | null;
}

const STATUS_TONE: Record<TraceSpan['status'], 'success' | 'danger' | 'warning'> = {
  ok: 'success',
  error: 'danger',
  denied: 'warning',
}; // 'ok' is 'success' spelled the way the rest of this file's callers spell every other tone.

function widthPercent(span: TraceSpan, totalDurationMs: number | null): number {
  if (totalDurationMs === null || totalDurationMs <= 0) return 0;
  return Math.min(100, Math.max(0.5, (span.durationMs / totalDurationMs) * 100));
}

function offsetPercent(span: TraceSpan, totalDurationMs: number | null): number {
  if (totalDurationMs === null || totalDurationMs <= 0) return 0;
  return Math.min(100, Math.max(0, (span.startedAtMs / totalDurationMs) * 100));
}

export function SpanWaterfall({ spans, totalDurationMs }: SpanWaterfallProps) {
  if (spans.length === 0) {
    return (
      <EmptyState
        message="No timeline available"
        description="The log store was not available for this trace, so the span-by-span timeline could not be reconstructed."
      />
    );
  }

  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Request timeline, in the order each stage completed</caption>
      <thead>
        <tr className="border-b border-slate-200 bg-slate-50 text-left">
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Stage
          </th>
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Start
          </th>
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Duration
          </th>
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Status
          </th>
          <th scope="col" className="w-1/3 px-3 py-2 font-medium text-slate-600">
            Timeline
          </th>
        </tr>
      </thead>
      <tbody>
        {spans.map((span) => (
          <tr key={span.spanId} className="border-b border-slate-100 last:border-b-0">
            <td className="px-3 py-2 font-mono text-xs text-slate-800">
              {span.name}
              {span.slow && (
                <span className="ml-2 inline-flex items-center gap-1 text-warning-700">
                  <AlertTriangle className="size-3.5" aria-hidden="true" />
                  <span className="text-xs font-medium">slow</span>
                </span>
              )}
            </td>
            <td className="px-3 py-2 text-slate-600">{span.startedAtMs.toFixed(1)}ms</td>
            <td className="px-3 py-2 text-slate-600">{span.durationMs.toFixed(1)}ms</td>
            <td className="px-3 py-2">
              <Badge tone={STATUS_TONE[span.status]}>{span.status}</Badge>
            </td>
            <td className="px-3 py-2">
              <div className="relative h-3 w-full rounded-full bg-slate-100" aria-hidden="true">
                <span
                  className={
                    'absolute top-0 h-3 rounded-full ' +
                    (span.slow
                      ? 'bg-warning-500'
                      : span.status === 'error'
                        ? 'bg-danger-500'
                        : span.status === 'denied'
                          ? 'bg-slate-400'
                          : 'bg-primary-500')
                  }
                  style={{
                    left: `${String(offsetPercent(span, totalDurationMs))}%`,
                    width: `${String(widthPercent(span, totalDurationMs))}%`,
                  }}
                />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
