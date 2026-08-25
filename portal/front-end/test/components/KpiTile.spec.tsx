import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KpiTile } from '../../src/components/KpiTile';

describe('KpiTile', () => {
  it('TC-1: renders label and value', () => {
    render(<KpiTile label="Active campaigns" value={42} />);
    expect(screen.getByText('Active campaigns')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('shows a skeleton instead of the value while loading', () => {
    const { container } = render(<KpiTile label="Active campaigns" value={42} isLoading />);
    expect(screen.queryByText('42')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders a trend indicator with direction text', () => {
    render(
      <KpiTile label="Active campaigns" value={42} trend={{ direction: 'up', value: '+4%' }} />,
    );
    expect(screen.getByText('+4%')).toBeInTheDocument();
  });
});
