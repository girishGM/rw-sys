import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PasswordStrengthMeter } from '../../../src/features/auth/PasswordStrengthMeter';

describe('PasswordStrengthMeter', () => {
  it('marks both requirements as not met for an empty password, pairing colour with text', () => {
    render(<PasswordStrengthMeter password="" />);
    expect(screen.getByText(/At least 12 characters/)).toBeInTheDocument();
    expect(screen.getByText(/At least 3 of:/)).toBeInTheDocument();
    // sr-only suffixes announce state to assistive tech, not colour alone (WCAG 1.4.1).
    expect(screen.getAllByText('— not met')).toHaveLength(2);
  });

  it('marks the length requirement met once long enough, class requirement still unmet', () => {
    render(<PasswordStrengthMeter password="aaaaaaaaaaaa" />);
    expect(screen.getAllByText('— met')).toHaveLength(1);
    expect(screen.getAllByText('— not met')).toHaveLength(1);
  });

  it('marks both requirements met for a compliant password', () => {
    render(<PasswordStrengthMeter password="CorrectHorse1!" />);
    expect(screen.getAllByText('— met')).toHaveLength(2);
    expect(screen.queryByText('— not met')).not.toBeInTheDocument();
  });
});
