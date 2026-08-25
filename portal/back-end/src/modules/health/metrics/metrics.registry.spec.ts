import { MetricsRegistry } from './metrics.registry';

/**
 * Parses the rendered text back into semantic samples, rather than asserting on substrings of
 * the output — the property under test is "a scraper can recover these numbers and labels",
 * not "the string looks like this today" (AGENT-PROTOCOL §3, "assert the observable property").
 */
interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parse(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (match === null)
      throw new Error(`Line does not match Prometheus exposition format: ${line}`);
    const [, name, , labelBlock, valueText] = match;
    const labels: Record<string, string> = {};
    if (labelBlock !== undefined && labelBlock.length > 0) {
      for (const pair of labelBlock.split(',')) {
        const eqIndex = pair.indexOf('=');
        const key = pair.slice(0, eqIndex);
        const rawValue = pair.slice(eqIndex + 1);
        labels[key] = rawValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    samples.push({ name: name!, labels, value: Number(valueText) });
  }
  return samples;
}

describe('MetricsRegistry', () => {
  it('renders only HELP/TYPE documentation for an empty registry — no sample lines', () => {
    const registry = new MetricsRegistry();
    const samples = parse(registry.render());
    expect(samples).toHaveLength(0);
  });

  it('produces exactly one HELP and one TYPE line per known metric name, even with no samples', () => {
    const registry = new MetricsRegistry();
    const lines = registry
      .render()
      .split('\n')
      .filter((l) => l.length > 0);
    const helpLines = lines.filter((l) => l.startsWith('# HELP db_pool_utilisation'));
    const typeLines = lines.filter((l) => l.startsWith('# TYPE db_pool_utilisation'));
    expect(helpLines).toHaveLength(1);
    expect(typeLines).toHaveLength(1);
    expect(typeLines[0]).toBe('# TYPE db_pool_utilisation gauge');
  });

  it('a scraper can recover a counter incremented across two label-sets', () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter('http_requests_total', { route: '/health', status: '200' });
    registry.incrementCounter('http_requests_total', { route: '/health', status: '200' });
    registry.incrementCounter('http_requests_total', { route: '/health', status: '503' }, 3);

    const samples = parse(registry.render()).filter((s) => s.name === 'http_requests_total');
    expect(samples).toHaveLength(2);
    expect(samples).toContainEqual({
      name: 'http_requests_total',
      labels: { route: '/health', status: '200' },
      value: 2,
    });
    expect(samples).toContainEqual({
      name: 'http_requests_total',
      labels: { route: '/health', status: '503' },
      value: 3,
    });
  });

  it('label order does not create two series for the same logical sample', () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter('auth_login_total', { result: 'success' });
    registry.incrementCounter('auth_login_total', { result: 'success' });

    const samples = parse(registry.render()).filter((s) => s.name === 'auth_login_total');
    expect(samples).toHaveLength(1);
    expect(samples[0]!.value).toBe(2);
  });

  it('a gauge overwrites rather than accumulates', () => {
    const registry = new MetricsRegistry();
    registry.setGauge('db_pool_utilisation', {}, 0.4);
    registry.setGauge('db_pool_utilisation', {}, 0.9);

    const samples = parse(registry.render()).filter((s) => s.name === 'db_pool_utilisation');
    expect(samples).toHaveLength(1);
    expect(samples[0]!.value).toBe(0.9);
  });

  it('a histogram exposes cumulative buckets, +Inf, sum and count that a scraper can recover', () => {
    const registry = new MetricsRegistry();
    [0.02, 0.2, 2].forEach((v) =>
      registry.observeHistogram('http_request_duration_seconds', { route: '/campaigns' }, v),
    );

    const samples = parse(registry.render());
    const buckets = samples.filter(
      (s) => s.name === 'http_request_duration_seconds_bucket' && s.labels.route === '/campaigns',
    );
    const le = (bound: string): number => buckets.find((b) => b.labels.le === bound)!.value;

    // Cumulative: every bucket >= a bound counts every observation <= that bound.
    expect(le('0.025')).toBe(1); // only 0.02
    expect(le('0.25')).toBe(2); // 0.02, 0.2
    expect(le('+Inf')).toBe(3); // all three, including the 2s observation past the last finite bucket

    const sum = samples.find(
      (s) => s.name === 'http_request_duration_seconds_sum' && s.labels.route === '/campaigns',
    );
    const count = samples.find(
      (s) => s.name === 'http_request_duration_seconds_count' && s.labels.route === '/campaigns',
    );
    expect(sum!.value).toBeCloseTo(2.22, 5);
    expect(count!.value).toBe(3);
  });

  it('escapes a double quote and a backslash in a label value so the line still parses', () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter('http_requests_total', { route: '/x?"a"=\\b', status: '200' });

    const samples = parse(registry.render()).filter((s) => s.name === 'http_requests_total');
    expect(samples).toHaveLength(1);
    expect(samples[0]!.labels.route).toBe('/x?"a"=\\b');
  });

  it('incrementCounter defaults to no labels and +1 when called with only a name', () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter('auth_login_total');
    registry.incrementCounter('auth_login_total');

    const samples = parse(registry.render()).filter((s) => s.name === 'auth_login_total');
    expect(samples).toEqual([{ name: 'auth_login_total', labels: {}, value: 2 }]);
  });

  it('setGauge defaults to no labels when called with just a name and a value', () => {
    const registry = new MetricsRegistry();
    registry.setGauge('db_pool_utilisation', undefined, 0.5);

    const samples = parse(registry.render()).filter((s) => s.name === 'db_pool_utilisation');
    expect(samples).toEqual([{ name: 'db_pool_utilisation', labels: {}, value: 0.5 }]);
  });

  it('observeHistogram defaults to no labels when called with just a name and a value', () => {
    const registry = new MetricsRegistry();
    registry.observeHistogram('http_request_duration_seconds', undefined, 0.1);

    const count = parse(registry.render()).find(
      (s) => s.name === 'http_request_duration_seconds_count',
    );
    expect(count).toEqual({ name: 'http_request_duration_seconds_count', labels: {}, value: 1 });
  });

  it('falls back to the default histogram buckets for a name outside KNOWN_METRICS', () => {
    const registry = new MetricsRegistry();
    registry.observeHistogram('a_custom_ad_hoc_histogram', {}, 0.02);

    const buckets = parse(registry.render()).filter(
      (s) => s.name === 'a_custom_ad_hoc_histogram_bucket',
    );
    // The default bucket set is http_request_duration_seconds' own (metrics.registry.ts's
    // header: "MetricsRegistry accepts any name — this is documentation, not an allowlist").
    expect(buckets.map((b) => b.labels.le)).toEqual([
      '0.005',
      '0.01',
      '0.025',
      '0.05',
      '0.1',
      '0.25',
      '0.5',
      '1',
      '2.5',
      '5',
      '10',
      '+Inf',
    ]);
  });

  it('reset() clears every series', () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter('auth_login_total', { result: 'success' });
    registry.reset();

    const samples = parse(registry.render()).filter((s) => s.name === 'auth_login_total');
    expect(samples).toHaveLength(0);
  });
});
