import { Counter, Gauge, Histogram } from './metrics-primitives';

describe('Counter', () => {
  it('renders HELP/TYPE lines and a zero value before any inc()', () => {
    const counter = new Counter('widgets_total', 'Total widgets.');
    expect(counter.toPrometheus()).toBe(
      [
        '# HELP widgets_total Total widgets.',
        '# TYPE widgets_total counter',
        'widgets_total 0',
      ].join('\n'),
    );
  });

  it('accumulates per label combination independently', () => {
    const counter = new Counter('codes_generated_total', 'help', ['transport', 'outcome']);
    counter.inc({ transport: 'KAFKA', outcome: 'SUCCESS' });
    counter.inc({ transport: 'KAFKA', outcome: 'SUCCESS' });
    counter.inc({ transport: 'GRPC', outcome: 'FAILED' });

    const text = counter.toPrometheus();
    expect(text).toContain('codes_generated_total{transport="KAFKA",outcome="SUCCESS"} 2');
    expect(text).toContain('codes_generated_total{transport="GRPC",outcome="FAILED"} 1');
  });
});

describe('Gauge', () => {
  it('reports the last set() value, defaulting to 0 when never set', () => {
    const gauge = new Gauge('pending', 'help');
    expect(gauge.toPrometheus()).toContain('pending 0');

    gauge.set(3);
    gauge.set(7);
    expect(gauge.toPrometheus()).toContain('pending 7');
  });
});

describe('Histogram', () => {
  it('renders zeroed buckets/_sum/_count before any observe()', () => {
    const histogram = new Histogram('latency_seconds', 'help', [0.1, 1]);
    const text = histogram.toPrometheus();
    expect(text).toContain('latency_seconds_bucket{le="0.1"} 0');
    expect(text).toContain('latency_seconds_bucket{le="1"} 0');
    expect(text).toContain('latency_seconds_bucket{le="+Inf"} 0');
    expect(text).toContain('latency_seconds_sum 0');
    expect(text).toContain('latency_seconds_count 0');
  });

  it('produces cumulative bucket counts and a correct _sum/_count', () => {
    const histogram = new Histogram('latency_seconds', 'help', [0.1, 0.5, 1]);
    histogram.observe(0.05);
    histogram.observe(0.3);
    histogram.observe(0.9);

    const text = histogram.toPrometheus();
    expect(text).toContain('latency_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('latency_seconds_bucket{le="0.5"} 2');
    expect(text).toContain('latency_seconds_bucket{le="1"} 3');
    expect(text).toContain('latency_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('latency_seconds_sum 1.25');
    expect(text).toContain('latency_seconds_count 3');
  });

  // TC-5's own point: a retry-heavy (slower) request must show up as a slower observation,
  // not be filtered out or normalised away.
  it('reflects a slow, retry-heavy observation in the higher buckets, not the fast ones', () => {
    const histogram = new Histogram('latency_seconds', 'help', [0.01, 0.05, 1], ['transport']);
    histogram.observe(0.002, { transport: 'KAFKA' }); // fast, no retries
    histogram.observe(0.4, { transport: 'KAFKA' }); // slow, simulating 2 collision retries

    const text = histogram.toPrometheus();
    expect(text).toContain('latency_seconds_bucket{transport="KAFKA",le="0.01"} 1');
    expect(text).toContain('latency_seconds_bucket{transport="KAFKA",le="0.05"} 1');
    expect(text).toContain('latency_seconds_bucket{transport="KAFKA",le="1"} 2');
  });
});
