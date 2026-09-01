/**
 * T-005 — each tone maps to the right accent/warn/muted token pairing (UI-UX-DESIGN.md
 * "Core components": active/unused = accent-soft/accent-strong, ends-soon/expiring =
 * warn-soft/warn-strong, used/inactive = surface-2/muted text).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './Badge';

describe('Badge', () => {
  it('defaults to the accent tone', () => {
    render(<Badge>Active</Badge>);
    const badge = screen.getByText('Active');
    expect(badge).toHaveClass('bg-accent-soft');
    expect(badge).toHaveClass('text-accent-strong');
  });

  it('renders the warn tone for expiring/ends-soon status', () => {
    render(<Badge tone="warn">Expires in 2 days</Badge>);
    const badge = screen.getByText('Expires in 2 days');
    expect(badge).toHaveClass('bg-warn-soft');
    expect(badge).toHaveClass('text-warn-strong');
  });

  it('renders the muted tone for used/inactive status', () => {
    render(<Badge tone="muted">Used</Badge>);
    const badge = screen.getByText('Used');
    expect(badge).toHaveClass('bg-surface-2');
    expect(badge).toHaveClass('text-ink-muted');
  });
});
