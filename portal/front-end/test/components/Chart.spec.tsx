import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chart } from '../../src/components/Chart';

describe('Chart', () => {
  it('TC-1: exposes an accessible name and a text alternative for every data point', () => {
    render(
      <Chart
        title="Redemptions by week"
        data={[
          { label: 'Week 1', value: 10 },
          { label: 'Week 2', value: 25 },
        ]}
      />,
    );
    expect(screen.getByRole('group', { name: 'Redemptions by week' })).toBeInTheDocument();
    // sr-only data table gives assistive tech a real text alternative for the SVG.
    expect(screen.getByText('Week 1')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
  });
});
