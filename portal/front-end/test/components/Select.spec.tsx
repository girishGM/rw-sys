import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select, type SelectOption } from '../../src/components/Select';

const OPTIONS: SelectOption[] = [
  { value: 'IN', label: 'India' },
  { value: 'ID', label: 'Indonesia' },
  { value: 'PH', label: 'Philippines' },
];

function ControlledSelect({ onSelect }: { onSelect?: (v: string) => void }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <Select
      label="Country"
      options={OPTIONS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onSelect?.(next);
      }}
    />
  );
}

describe('Select', () => {
  it('renders a labelled combobox trigger, closed by default', () => {
    render(<ControlledSelect />);
    const trigger = screen.getByRole('combobox', { name: /Country/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on click and lists every option', async () => {
    const user = userEvent.setup();
    render(<ControlledSelect />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('ArrowDown then Enter selects the option and closes the popup, returning focus to the trigger', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledSelect onSelect={onSelect} />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // open, active = India (index 0)
    await user.keyboard('{ArrowDown}'); // active = Indonesia (index 1)
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('ID');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole('combobox')).toHaveTextContent('Indonesia');
  });

  it('Escape closes without changing the value', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledSelect onSelect={onSelect} />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('typeahead jumps the active option to the first matching label', async () => {
    const user = userEvent.setup();
    render(<ControlledSelect />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // open
    await user.keyboard('p');
    expect(trigger).toHaveAttribute('aria-activedescendant', expect.stringContaining('option-2'));
  });

  it('shows an inline error via aria-invalid/aria-describedby', () => {
    render(
      <Select
        label="Country"
        options={OPTIONS}
        value={null}
        onChange={() => {}}
        error="Choose a country"
      />,
    );
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a country');
  });
});
