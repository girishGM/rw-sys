import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TraceSpan } from '@reward-portal/shared';
import { SpanWaterfall } from './SpanWaterfall';

const okSpan: TraceSpan = {
  name: 'jwt.verify',
  startedAtMs: 0.2,
  durationMs: 0.8,
  status: 'ok',
  spanId: 'a1',
  slow: false,
  attributes: null,
};

const slowSpan: TraceSpan = {
  name: 'notify.checkers',
  startedAtMs: 20,
  durationMs: 98,
  status: 'ok',
  spanId: 'a2',
  slow: true,
  attributes: null,
};

const errorSpan: TraceSpan = {
  name: 'campaigns.submit',
  startedAtMs: 5,
  durationMs: 40,
  status: 'error',
  spanId: 'a3',
  slow: false,
  attributes: null,
};

describe('SpanWaterfall', () => {
  it('renders an empty state with no spans, rather than an empty table', () => {
    render(<SpanWaterfall spans={[]} totalDurationMs={142} />);
    expect(screen.getByText('No timeline available')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders every span, in order, with its name and duration as real text (TC-13)', () => {
    render(<SpanWaterfall spans={[okSpan, slowSpan]} totalDurationMs={142} />);

    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('jwt.verify');
    expect(rows[0]).toHaveTextContent('0.8ms');
    expect(rows[1]).toHaveTextContent('notify.checkers');
    expect(rows[1]).toHaveTextContent('98.0ms');
  });

  it('marks the slow span with visible text, not colour alone (WCAG 1.4.1)', () => {
    render(<SpanWaterfall spans={[okSpan, slowSpan]} totalDurationMs={142} />);
    expect(screen.getByText('slow')).toBeInTheDocument();
  });

  it('does not mark a fast span as slow', () => {
    render(<SpanWaterfall spans={[okSpan]} totalDurationMs={142} />);
    expect(screen.queryByText('slow')).not.toBeInTheDocument();
  });

  it('shows the status of every span, including error (TC-2)', () => {
    render(<SpanWaterfall spans={[errorSpan]} totalDurationMs={100} />);
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('renders a denied span — the chain refusing, not failing', () => {
    const deniedSpan: TraceSpan = {
      name: 'permission.check',
      startedAtMs: 1,
      durationMs: 2,
      status: 'denied',
      spanId: 'd1',
      slow: false,
      attributes: null,
    };
    render(<SpanWaterfall spans={[deniedSpan]} totalDurationMs={100} />);
    expect(screen.getByText('denied')).toBeInTheDocument();
  });

  it('renders without throwing when the total duration is unknown', () => {
    render(<SpanWaterfall spans={[okSpan]} totalDurationMs={null} />);
    expect(screen.getByText('jwt.verify')).toBeInTheDocument();
  });
});
