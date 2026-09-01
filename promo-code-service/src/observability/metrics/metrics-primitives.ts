/**
 * T-PC-042. A tiny, dependency-free Prometheus-text-exposition-format primitive set
 * (`Counter`/`Gauge`/`Histogram`) — no `prom-client` (or any) new npm dependency, since
 * `package.json` is `agent-promo-foundation`'s own file (R8) and adding a dependency there is
 * out of this task's scope, same "no `test:e2e` script / no `testcontainers` dependency" precedent
 * T-PC-040's own completion report already accepted for an analogous gap. The output format these
 * three classes produce is plain, standard Prometheus text exposition format (implementation note
 * 3/TC-12) — parseable by any standard scraper, not a bespoke shape.
 */

/** Prometheus label values only need `\`, `"` and newlines escaped (the exposition format spec). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labelNames: readonly string[], labels: Record<string, string>): string {
  if (labelNames.length === 0) {
    return '';
  }
  return labelNames.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`).join(',');
}

export class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[] = [],
  ) {}

  inc(labels: Record<string, string> = {}, amount = 1): void {
    const key = formatLabels(this.labelNames, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines.join('\n');
    }
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[] = [],
  ) {}

  set(value: number, labels: Record<string, string> = {}): void {
    this.values.set(formatLabels(this.labelNames, labels), value);
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines.join('\n');
    }
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`);
    }
    return lines.join('\n');
  }
}

/**
 * Standard Prometheus histogram: each `_bucket{le="X"}` line is a *cumulative* count of every
 * observation `<= X` (the exposition format's own convention) — `observe()` below builds that
 * cumulative count directly (incrementing every bucket an observation falls at-or-under), rather
 * than a per-bucket-only count that would need summing at render time.
 */
export class Histogram {
  private readonly bucketCounts = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: readonly number[],
    private readonly labelNames: readonly string[] = [],
  ) {}

  observe(value: number, labels: Record<string, string> = {}): void {
    const key = formatLabels(this.labelNames, labels);
    let counts = this.bucketCounts.get(key);
    if (!counts) {
      counts = new Array<number>(this.buckets.length).fill(0);
      this.bucketCounts.set(key, counts);
    }
    this.buckets.forEach((bound, index) => {
      if (value <= bound) {
        counts![index] += 1;
      }
    });
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    if (this.bucketCounts.size === 0) {
      this.buckets.forEach((bound) => lines.push(`${this.name}_bucket{le="${bound}"} 0`));
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
      return lines.join('\n');
    }
    for (const [key, counts] of this.bucketCounts) {
      const labelPrefix = key ? `${key},` : '';
      this.buckets.forEach((bound, index) => {
        lines.push(`${this.name}_bucket{${labelPrefix}le="${bound}"} ${counts[index]}`);
      });
      const total = this.counts.get(key) ?? 0;
      lines.push(`${this.name}_bucket{${labelPrefix}le="+Inf"} ${total}`);
      lines.push(
        key
          ? `${this.name}_sum{${key}} ${this.sums.get(key) ?? 0}`
          : `${this.name}_sum ${this.sums.get(key) ?? 0}`,
      );
      lines.push(key ? `${this.name}_count{${key}} ${total}` : `${this.name}_count ${total}`);
    }
    return lines.join('\n');
  }
}
