import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DatePicker } from '../../src/components/DatePicker';

function ControlledDatePicker({ onSelect }: { onSelect?: (d: Date | null) => void }) {
  const [value, setValue] = useState<Date | null>(null);
  return (
    <DatePicker
      label="Start date"
      value={value}
      onChange={(next) => {
        setValue(next);
        onSelect?.(next);
      }}
    />
  );
}

describe('DatePicker', () => {
  it('TC-12: a validly typed date parses on blur', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledDatePicker onSelect={onSelect} />);
    const input = screen.getByLabelText('Start date');
    await user.type(input, '2026-09-01');
    await user.tab();
    expect(onSelect).toHaveBeenCalledWith(new Date(2026, 8, 1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('TC-12: invalid typed input shows an inline error and does not call onChange with a date', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledDatePicker onSelect={onSelect} />);
    const input = screen.getByLabelText('Start date');
    await user.type(input, 'not-a-date');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid date/i);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens a calendar grid and selects a day by click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledDatePicker onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: 'Open calendar' }));
    expect(screen.getByRole('dialog', { name: 'Choose date' })).toBeInTheDocument();
    const fifteenth = screen.getAllByRole('gridcell', { name: '15' })[0];
    await user.click(fifteenth);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('arrow keys move focus within the grid by one day', async () => {
    const user = userEvent.setup();
    render(<ControlledDatePicker />);
    await user.click(screen.getByRole('button', { name: 'Open calendar' }));
    const grid = screen.getByRole('grid');
    const focusable = grid.querySelector('[tabindex="0"]') as HTMLElement;
    focusable.focus();
    const dayBefore = focusable.getAttribute('data-day');
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(document.activeElement).not.toBe(focusable));
    expect(document.activeElement?.getAttribute('data-day')).not.toBe(dayBefore);
  });

  it('Escape closes the calendar popup', async () => {
    const user = userEvent.setup();
    render(<ControlledDatePicker />);
    await user.click(screen.getByRole('button', { name: 'Open calendar' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
