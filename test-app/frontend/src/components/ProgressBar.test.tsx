/**
 * T-005 — the track exposes real `role="progressbar"` semantics (not just a visually-styled
 * div), and the fill width is derived from `value`, clamped to a legal 0-100 range.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('exposes accessible progressbar semantics for the given value', () => {
    render(<ProgressBar value={42} aria-label="Summer Cashback Sprint progress" />);
    const bar = screen.getByRole('progressbar', { name: 'Summer Cashback Sprint progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('clamps a value above 100 down to 100', () => {
    render(<ProgressBar value={140} aria-label="over" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('clamps a negative value up to 0', () => {
    render(<ProgressBar value={-20} aria-label="under" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it("sizes the fill element's width to the clamped percentage", () => {
    render(<ProgressBar value={30} aria-label="fill" />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('30%');
  });
});
