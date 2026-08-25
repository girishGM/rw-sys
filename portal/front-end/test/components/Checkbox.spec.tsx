import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from '../../src/components/Checkbox';

describe('Checkbox', () => {
  it('is a real checkbox, labelled and toggleable by keyboard (Space)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Send email receipt" checked={false} onChange={onChange} />);
    const checkbox = screen.getByLabelText('Send email receipt');
    expect(checkbox).toHaveAttribute('type', 'checkbox');
    await user.tab();
    expect(checkbox).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('renders the indeterminate visual and aria-checked="mixed"', () => {
    render(<Checkbox label="Select all" checked={false} indeterminate onChange={() => {}} />);
    const checkbox = screen.getByLabelText('Select all') as HTMLInputElement;
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox).toHaveAttribute('aria-checked', 'mixed');
  });

  it('associates an error message via aria-describedby', () => {
    render(<Checkbox label="Accept terms" checked={false} onChange={() => {}} error="Required" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Required');
  });
});
