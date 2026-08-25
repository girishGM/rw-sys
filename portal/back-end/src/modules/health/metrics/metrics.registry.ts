/**
 * T-052 — the in-process metrics store behind `GET /metrics` (08-OBSERVABILITY.md §8).
 *
 * Deliberately dependency-free, the same reasoning `scripts/scan-secrets.sh` gives for
 * itself: no `prom-client`, no third-party registry, just three label-keyed maps and a
 * renderer for the Prometheus text exposition format
 * (https://prometheus.io/docs/instrumenting/exposition_formats/). A metrics library is a
 * reasonable choice on a green-field service; adding one here would be a new production
 * dependency for three data structures this file implements in about a hundred lines, and
 * every one of those lines is unit-tested below rather than trusted from a changelog.
 *
 * **What this class owns, and what it deliberately does not.** It is a generic counter/
 * gauge/histogram store — `MetricsModule` exports it globally so any module in the graph can
 * call `incrementCounter`/`setGauge`/`observeHistogram` — plus the HTTP-boundary instrumentation
 * `MetricsMiddleware` drives from `main.ts`. It does **not** itself call into `auth`, `rbac`,
 * `crypto` or `data-protection` to populate `auth_login_total`, `auth_permission_denied_total`,
 * `auth_refresh_reuse_detected_total`, `rule_evaluations_total`, `crypto_decrypt_failures_total`,
 * `pii_reveal_total` or `rbac_cache_hit_ratio` — those events happen inside files this task does
 * not own (AGENT-PROTOCOL R9), and deriving them approximately from HTTP status codes here would
 * produce a metric that *looks* like the real thing (right name, right shape) while silently
 * mislabelling every sample — the exact failure mode AGENT-PROTOCOL's "assert the observable
 * property" note warns against, one level removed. See this task's completion report for the
 * follow-up filed against the owning modules; the seam (this registry, exported globally) is
 * ready for them to call into today.
 */
import { Injectable } from '@nestjs/common';

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  /** Histogram bucket upper bounds, in the metric's own unit. Ignored for counter/gauge. */
  readonly buckets?: readonly number[];
}

export type Labels = Readonly<Record<string, string | number>>;

/** 08-OBSERVABILITY.md §8's own list, verbatim. `MetricsRegistry` accepts any name — this is
 * documentation (rendered as the `# HELP`/`# TYPE` lines), not an allowlist. */
export const KNOWN_METRICS: readonly MetricDefinition[] = [
  {
    name: 'http_requests_total',
    help: 'Total HTTP requests, by parameterised route and response status.',
    type: 'counter',
  },
  {
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by parameterised route.',
    type: 'histogram',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
  {
    name: 'auth_login_total',
    help: 'Login attempts, by result (success|failure).',
    type: 'counter',
  },
  {
    name: 'auth_permission_denied_total',
    help: 'Requests rejected by RolesGuard/PermissionsGuard, by role and entity.',
    type: 'counter',
  },
  {
    name: 'auth_refresh_reuse_detected_total',
    help: 'Refresh-token replay detections (02-SECURITY.md §3). Should always be zero.',
    type: 'counter',
  },
  {
    name: 'rbac_cache_hit_ratio',
    help: 'PermissionCacheService hit ratio, 0-1, sampled at scrape time.',
    type: 'gauge',
  },
  {
    name: 'db_pool_utilisation',
    help: 'Sequelize connection pool: in-use connections divided by the configured maximum.',
    type: 'gauge',
  },
  {
    name: 'rule_evaluations_total',
    help: 'Rule engine evaluations, by decision.',
    type: 'counter',
  },
  {
    name: 'crypto_decrypt_failures_total',
    help: 'Field-level decrypt failures (key misconfiguration or tampering).',
    type: 'counter',
  },
  {
    name: 'pii_reveal_total',
    help: 'PII reveal-endpoint calls, by the revealing actor role.',
    type: 'counter',
  },
];

interface HistogramState {
  buckets: readonly number[];
  /** Cumulative count per bucket upper bound, keyed the same as `buckets`' indices. */
  bucketCounts: number[];
  sum: number;
  count: number;
}

/** Deterministic label-set key: sorted by key so `{b:1,a:2}` and `{a:2,b:1}` collide, as they
 * must — they are the same series. */
function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}=${JSON.stringify(String(labels[key]))}`).join(',');
}

function formatLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const rendered = keys.map((key) => `${key}="${escapeLabelValue(String(labels[key]))}"`).join(',');
  return `{${rendered}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

@Injectable()
export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private readonly gauges = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private readonly histograms = new Map<string, Map<string, { labels: Labels } & HistogramState>>();
  private readonly definitions = new Map<string, MetricDefinition>(
    KNOWN_METRICS.map((def) => [def.name, def]),
  );

  incrementCounter(name: string, labels: Labels = {}, value = 1): void {
    const series = this.seriesMapFor(this.counters, name);
    const key = labelKey(labels);
    const existing = series.get(key);
    series.set(key, { labels, value: (existing?.value ?? 0) + value });
  }

  setGauge(name: string, labels: Labels = {}, value: number): void {
    const series = this.seriesMapFor(this.gauges, name);
    series.set(labelKey(labels), { labels, value });
  }

  observeHistogram(name: string, labels: Labels = {}, value: number): void {
    const definition = this.definitions.get(name);
    const buckets = definition?.buckets ?? KNOWN_METRICS[1]!.buckets!;
    const series = this.histogramSeriesMapFor(name);
    const key = labelKey(labels);
    const existing = series.get(key);
    const state: { labels: Labels } & HistogramState = existing ?? {
      labels,
      buckets,
      bucketCounts: buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    state.sum += value;
    state.count += 1;
    state.bucketCounts = state.bucketCounts.map((count, index) =>
      value <= state.buckets[index]! ? count + 1 : count,
    );
    series.set(key, state);
  }

  /** Test/CI hook. Not called from application code — a live process's counters should never
   * reset mid-run, or a scrape mid-reset would report a bogus drop to zero. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  /** Prometheus text exposition format (one `# HELP`/`# TYPE` pair per metric name, then one
   * line per label-set actually observed — never a zero-filled cross product of every label
   * this process has never seen, which would misrepresent scale on a low-traffic route). */
  render(): string {
    const lines: string[] = [];
    const names = new Set<string>([
      ...this.definitions.keys(),
      ...this.counters.keys(),
      ...this.gauges.keys(),
      ...this.histograms.keys(),
    ]);

    for (const name of names) {
      const definition = this.definitions.get(name);
      if (definition !== undefined) {
        lines.push(`# HELP ${name} ${definition.help}`);
        lines.push(`# TYPE ${name} ${definition.type}`);
      }

      if (this.counters.has(name)) {
        for (const { labels, value } of this.counters.get(name)!.values()) {
          lines.push(`${name}${formatLabels(labels)} ${value}`);
        }
      }
      if (this.gauges.has(name)) {
        for (const { labels, value } of this.gauges.get(name)!.values()) {
          lines.push(`${name}${formatLabels(labels)} ${value}`);
        }
      }
      if (this.histograms.has(name)) {
        for (const state of this.histograms.get(name)!.values()) {
          state.buckets.forEach((le, index) => {
            const labels = { ...state.labels, le: String(le) };
            lines.push(`${name}_bucket${formatLabels(labels)} ${state.bucketCounts[index]}`);
          });
          const infLabels = { ...state.labels, le: '+Inf' };
          lines.push(`${name}_bucket${formatLabels(infLabels)} ${state.count}`);
          lines.push(`${name}_sum${formatLabels(state.labels)} ${state.sum}`);
          lines.push(`${name}_count${formatLabels(state.labels)} ${state.count}`);
        }
      }
    }

    // `lines` always has at least the HELP/TYPE pair for every entry in `KNOWN_METRICS`
    // (`names` is seeded from `this.definitions.keys()` unconditionally, above), so it can
    // never be empty — no conditional trailing newline to get wrong or leave untested.
    return `${lines.join('\n')}\n`;
  }

  private seriesMapFor(
    store: Map<string, Map<string, { labels: Labels; value: number }>>,
    name: string,
  ): Map<string, { labels: Labels; value: number }> {
    let series = store.get(name);
    if (series === undefined) {
      series = new Map();
      store.set(name, series);
    }
    return series;
  }

  private histogramSeriesMapFor(name: string): Map<string, { labels: Labels } & HistogramState> {
    let series = this.histograms.get(name);
    if (series === undefined) {
      series = new Map();
      this.histograms.set(name, series);
    }
    return series;
  }
}
