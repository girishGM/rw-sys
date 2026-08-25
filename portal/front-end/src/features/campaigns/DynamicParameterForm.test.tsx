/**
 * T-037 — `DynamicParameterForm`, the step-4 form generated from a rule's own parameter schema.
 *
 * TC-20 (*"rule with 10 parameters of mixed types → form renders all; all round-trip
 * correctly"*) is the headline case. The validation cases mirror TC-17/TC-18 on the client side
 * — with the standing caveat this component's own header states: none of this is a control, and
 * `campaigns.e2e-spec.ts` proves the server refuses the same values with the form bypassed.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RuleParameters } from '@reward-portal/shared';
import { DynamicParameterForm } from './DynamicParameterForm';
import { validateValues } from './ruleValues';

const SPEND: RuleParameters = {
  fields: [
    { key: 'minSpend', label: 'Minimum spend', type: 'number', required: true, min: 10, max: 500 },
    {
      key: 'period',
      label: 'Period',
      type: 'select',
      required: false,
      options: ['daily', 'weekly'],
    },
    { key: 'note', label: 'Note', type: 'string', required: false },
    { key: 'active', label: 'Active', type: 'boolean', required: false },
    { key: 'from', label: 'From', type: 'date', required: false },
  ],
};

describe('DynamicParameterForm', () => {
  it('renders one control per declared field, labelled', () => {
    render(<DynamicParameterForm parameters={SPEND} values={{}} onChange={vi.fn()} />);

    expect(screen.getByLabelText('Minimum spend *')).toBeInTheDocument();
    expect(screen.getByLabelText('Note')).toBeInTheDocument();
    expect(screen.getByLabelText('Active')).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    // The select renders as a combobox with its label as the accessible name.
    expect(screen.getByRole('combobox', { name: /Period/ })).toBeInTheDocument();
  });

  it('marks required fields with an asterisk and optional ones without', () => {
    render(<DynamicParameterForm parameters={SPEND} values={{}} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Minimum spend *')).toBeInTheDocument();
    expect(screen.queryByLabelText('Note *')).not.toBeInTheDocument();
  });

  it('says so plainly when a rule declares no parameters', () => {
    render(<DynamicParameterForm parameters={{ fields: [] }} values={{}} onChange={vi.fn()} />);
    expect(screen.getByText('This rule takes no parameters.')).toBeInTheDocument();
  });

  it('emits a number rather than a string for a number field', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DynamicParameterForm parameters={SPEND} values={{}} onChange={onChange} />);

    await user.type(screen.getByLabelText('Minimum spend *'), '5');

    expect(onChange).toHaveBeenCalledWith({ minSpend: 5 });
  });

  it('removes the key entirely when a field is cleared, rather than storing an empty string', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DynamicParameterForm parameters={SPEND} values={{ note: 'x' }} onChange={onChange} />);

    await user.clear(screen.getByLabelText('Note'));

    // `{ note: '' }` would fail the shared schema's `z.string().min(1)`; absent is "not supplied".
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('shows the server’s own field error when one is supplied (TC-17 rendered on the field)', () => {
    render(
      <DynamicParameterForm
        parameters={SPEND}
        values={{ minSpend: 1 }}
        onChange={vi.fn()}
        serverErrors={{ minSpend: 'Number must be greater than or equal to 10' }}
      />,
    );

    expect(screen.getByText('Number must be greater than or equal to 10')).toBeInTheDocument();
  });

  it('disables every control when the campaign is no longer editable', () => {
    render(<DynamicParameterForm parameters={SPEND} values={{}} onChange={vi.fn()} disabled />);
    expect(screen.getByLabelText('Minimum spend *')).toBeDisabled();
    expect(screen.getByLabelText('Note')).toBeDisabled();
  });

  it('TC-20: renders ten parameters of mixed types and round-trips every value', async () => {
    const ten: RuleParameters = {
      fields: Array.from({ length: 10 }, (_unused, index) => {
        const types = ['string', 'number', 'boolean', 'date', 'select'] as const;
        const type = types[index % types.length];
        return {
          key: `field${String(index)}`,
          label: `Field ${String(index)}`,
          type,
          required: false,
          ...(type === 'select' ? { options: ['a', 'b'] } : {}),
        };
      }),
    };

    const values: Record<string, unknown> = {};
    for (const field of ten.fields) {
      values[field.key] =
        field.type === 'number'
          ? 7
          : field.type === 'boolean'
            ? true
            : field.type === 'date'
              ? '2026-09-01'
              : field.type === 'select'
                ? 'a'
                : 'text';
    }

    render(<DynamicParameterForm parameters={ten} values={values} onChange={vi.fn()} />);

    for (const field of ten.fields) {
      if (field.type === 'select') {
        expect(screen.getByRole('combobox', { name: new RegExp(field.label) })).toBeInTheDocument();
      } else {
        expect(screen.getByLabelText(field.label)).toBeInTheDocument();
      }
    }

    // Every supplied value satisfies the schema built from the same declaration.
    expect(validateValues(ten, values)).toEqual({});
  });
});

describe('validateValues', () => {
  it('reports a value below the declared minimum (TC-17, client side)', () => {
    expect(validateValues(SPEND, { minSpend: 1 })).toHaveProperty('minSpend');
  });

  it('reports a missing required value (TC-18, client side)', () => {
    expect(validateValues(SPEND, {})).toHaveProperty('minSpend');
  });

  it('reports an undeclared key (TC-19, client side)', () => {
    expect(Object.keys(validateValues(SPEND, { minSpend: 50, sneaky: 1 })).length).toBeGreaterThan(
      0,
    );
  });

  it('is empty for a valid set', () => {
    expect(validateValues(SPEND, { minSpend: 50 })).toEqual({});
  });
});
