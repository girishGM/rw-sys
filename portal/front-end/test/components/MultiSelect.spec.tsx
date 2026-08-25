import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiSelect, type MultiSelectOption } from '../../src/components/MultiSelect';

const OPTIONS: MultiSelectOption[] = [
  { value: 'IN', label: 'India' },
  { value: 'ID', label: 'Indonesia' },
  { value: 'PH', label: 'Philippines' },
];

const MANY_OPTIONS: MultiSelectOption[] = Array.from({ length: 500 }, (_, i) => ({
  value: `country-${i}`,
  label: `Country ${i}`,
}));

function ControlledMultiSelect({ options = OPTIONS }: { options?: MultiSelectOption[] }) {
  const [value, setValue] = useState<string[]>([]);
  return <MultiSelect label="Countries" options={options} value={value} onChange={setValue} />;
}

describe('MultiSelect', () => {
  it('renders a labelled trigger showing the selection count', async () => {
    const user = userEvent.setup();
    render(<ControlledMultiSelect />);
    const trigger = screen.getByRole('button', { name: /Countries/ });
    expect(trigger).toHaveTextContent('Select…');
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'India' }));
    expect(screen.getByRole('button', { name: /Countries/ })).toHaveTextContent('1 selected');
  });

  it('opening focuses the filter input and clicking an option keeps the popup open (multi-select)', async () => {
    const user = userEvent.setup();
    render(<ControlledMultiSelect />);
    await user.click(screen.getByRole('button', { name: /Countries/ }));
    expect(screen.getByPlaceholderText('Filter options')).toHaveFocus();
    await user.click(screen.getByRole('option', { name: 'India' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'India' })).toHaveAttribute('aria-selected', 'true');
  });

  it('typing into the filter narrows the visible options', async () => {
    const user = userEvent.setup();
    render(<ControlledMultiSelect />);
    await user.click(screen.getByRole('button', { name: /Countries/ }));
    await user.type(screen.getByPlaceholderText('Filter options'), 'Indo');
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Indonesia')).toBeInTheDocument();
    expect(within(listbox).queryByText('Philippines')).not.toBeInTheDocument();
  });

  it('TC-13: with 500 options, only a small window of rows is ever mounted', async () => {
    const user = userEvent.setup();
    render(<ControlledMultiSelect options={MANY_OPTIONS} />);
    await user.click(screen.getByRole('button', { name: /Countries/ }));
    const rendered = screen.getAllByRole('option');
    // Viewport (240px / 36px-rows) + overscan is well under 30 rows, nowhere near 500.
    expect(rendered.length).toBeLessThan(30);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('TC-13: filtering 500 options stays responsive and narrows results', async () => {
    const user = userEvent.setup();
    render(<ControlledMultiSelect options={MANY_OPTIONS} />);
    await user.click(screen.getByRole('button', { name: /Countries/ }));
    await user.type(screen.getByPlaceholderText('Filter options'), 'Country 42');
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Country 42')).toBeInTheDocument();
    expect(within(listbox).queryByText('Country 1')).not.toBeInTheDocument();
  });

  it('Escape closes the popup', async () => {
    const user = userEvent.setup();
    render(<ControlledMultiSelect />);
    await user.click(screen.getByRole('button', { name: /Countries/ }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows an inline error via aria-invalid/aria-describedby', () => {
    render(
      <MultiSelect
        label="Countries"
        options={OPTIONS}
        value={[]}
        onChange={vi.fn()}
        error="Pick at least one"
      />,
    );
    expect(screen.getByRole('button', { name: /Countries/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one');
  });
});
