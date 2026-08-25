import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../../src/components/Badge';

describe('Badge', () => {
  it('TC-1: renders its children with the default tone', () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('applies tone-specific classes', () => {
    render(<Badge tone="danger">Overdue</Badge>);
    expect(screen.getByText('Overdue').className).toMatch(/danger/);
  });
});
