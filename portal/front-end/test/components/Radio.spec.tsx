import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RadioGroup } from '../../src/components/Radio';

describe('RadioGroup', () => {
  it('groups native radios under a labelled fieldset', () => {
    render(
      <RadioGroup
        name="frequency"
        label="Frequency"
        options={[
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
        ]}
        value="daily"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('group', { name: 'Frequency' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Daily' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Weekly' })).not.toBeChecked();
  });

  it('arrow-keys move selection between options (native radio-group behaviour)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RadioGroup
        name="frequency"
        label="Frequency"
        options={[
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
        ]}
        value="daily"
        onChange={onChange}
      />,
    );
    screen.getByRole('radio', { name: 'Daily' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenCalledWith('weekly');
  });

  it('shows the group error message', () => {
    render(
      <RadioGroup
        name="frequency"
        label="Frequency"
        options={[{ value: 'daily', label: 'Daily' }]}
        value={null}
        onChange={() => {}}
        error="Select a frequency"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Select a frequency');
  });
});
