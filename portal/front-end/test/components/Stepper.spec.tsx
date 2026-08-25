import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stepper } from '../../src/components/Stepper';

describe('Stepper', () => {
  it('TC-14: the current step carries aria-current="step"', () => {
    render(
      <Stepper
        currentStep={1}
        steps={[{ label: 'Basics' }, { label: 'Countries' }, { label: 'Review' }]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).not.toHaveAttribute('aria-current');
    expect(items[2]).not.toHaveAttribute('aria-current');
  });

  it('TC-14: completed steps are marked, both visually and in the accessible name', () => {
    render(
      <Stepper
        currentStep={2}
        steps={[{ label: 'Basics' }, { label: 'Countries' }, { label: 'Review' }]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('completed');
    expect(items[1].textContent).toContain('completed');
    expect(items[2].textContent).toContain('current step');
  });
});
