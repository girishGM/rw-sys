import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RuleParameterField } from '@reward-portal/shared';
import { ParameterFieldsEditor } from './ParameterFieldsEditor';

describe('ParameterFieldsEditor', () => {
  it('renders an empty state when there are no fields', () => {
    render(<ParameterFieldsEditor fields={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/no parameters yet/i)).toBeInTheDocument();
  });

  it('adds a new blank field row', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ParameterFieldsEditor fields={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /add field/i }));

    expect(onChange).toHaveBeenCalledWith([
      { key: '', label: '', type: 'string', required: false },
    ]);
  });

  it('removes a field row', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const fields: RuleParameterField[] = [
      { key: 'minSpend', label: 'Minimum spend', type: 'number', required: true },
    ];
    render(<ParameterFieldsEditor fields={fields} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /remove field/i }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('flags duplicate keys client-side (mirrors the server meta-schema, TC-14)', () => {
    const fields: RuleParameterField[] = [
      { key: 'a', label: 'A', type: 'string', required: true },
      { key: 'a', label: 'A again', type: 'string', required: false },
    ];
    render(<ParameterFieldsEditor fields={fields} onChange={vi.fn()} />);

    expect(screen.getAllByText('Duplicate key')).toHaveLength(2);
  });

  it('shows an options input only for a select-type field', () => {
    const fields: RuleParameterField[] = [
      { key: 'tier', label: 'Tier', type: 'select', required: true, options: ['gold', 'silver'] },
    ];
    render(<ParameterFieldsEditor fields={fields} onChange={vi.fn()} />);

    expect(screen.getByLabelText(/options \(comma-separated\)/i)).toBeInTheDocument();
  });
});
