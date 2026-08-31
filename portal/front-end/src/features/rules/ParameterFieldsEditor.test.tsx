import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RuleParameterField } from '@reward-portal/shared';
import { ParameterFieldsEditor, type ParameterFieldsEditorProps } from './ParameterFieldsEditor';

/**
 * `ParameterFieldsEditor` is a plain controlled component (its own header comment) — it never
 * re-renders itself from a click, only from a new `fields` prop its parent supplies. A test that
 * wants to see the picker actually flip states (as opposed to just asserting the `onChange` call
 * a real parent would apply) needs that same round trip, not a bare `vi.fn()` that swallows it.
 */
function ControlledEditor(
  props: Omit<ParameterFieldsEditorProps, 'fields' | 'onChange'> & {
    readonly initialFields: RuleParameterField[];
    readonly onChange?: (fields: RuleParameterField[]) => void;
  },
) {
  const { initialFields, onChange, ...rest } = props;
  const [fields, setFields] = useState(initialFields);
  return (
    <ParameterFieldsEditor
      {...rest}
      fields={fields}
      onChange={(next) => {
        setFields(next);
        onChange?.(next);
      }}
    />
  );
}

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

  // T-115 — the resolver-driven role badge defaults to "Compared value" with no resolver
  // previewed, and reads "Resolver input" only for a `key` in `resolverInputFieldKeys`.
  it('badges a field "Compared value" by default (no resolver previewed)', () => {
    const fields: RuleParameterField[] = [
      { key: 'minSpend', label: 'Minimum spend', type: 'number', required: true },
    ];
    render(<ParameterFieldsEditor fields={fields} onChange={vi.fn()} />);

    // `{ selector: 'span' }` targets the read-only role `Badge` specifically — T-160 added a
    // static "Role matters: **Compared value** / **Resolver input**" help paragraph (rendered
    // as `<strong>`) above the field rows, which shares this exact wording.
    expect(screen.getByText('Compared value', { selector: 'span' })).toBeInTheDocument();
  });

  it('badges a field "Resolver input" when its key is in resolverInputFieldKeys', () => {
    const fields: RuleParameterField[] = [
      { key: 'targetComponentCode', label: 'Target component', type: 'string', required: true },
      { key: 'value', label: 'Value', type: 'string', required: true },
    ];
    render(
      <ParameterFieldsEditor
        fields={fields}
        onChange={vi.fn()}
        resolverInputFieldKeys={['targetComponentCode']}
      />,
    );

    expect(screen.getByText('Resolver input', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Compared value', { selector: 'span' })).toBeInTheDocument();
  });

  // T-125 — the value-source picker for a `select` field (13-REWARD-MASTER-VALUE-SOURCES.md §3).
  describe('value-source picker (T-125)', () => {
    const contextProviders = [
      {
        id: 1,
        providerCode: 'SIBLING_COMPONENTS',
        name: 'Sibling components',
        description: null,
        status: 'active' as const,
      },
    ];
    const apiLookupProviders = [
      {
        id: 1,
        providerCode: 'PRODUCT_CATALOG',
        name: 'Product catalog',
        description: null,
        endpointUrl: 'PLACEHOLDER',
        httpMethod: 'GET' as const,
        authType: 'none' as const,
        responseValueKey: 'id',
        responseLabelKey: 'name',
        status: 'planned' as const,
      },
    ];

    it('defaults a select field with no valueSource to "Fixed list" and keeps the options input', () => {
      const fields: RuleParameterField[] = [
        { key: 'tier', label: 'Tier', type: 'select', required: true, options: ['gold', 'silver'] },
      ];
      render(<ParameterFieldsEditor fields={fields} onChange={vi.fn()} />);

      expect(
        screen.getByRole('combobox', { name: /where do the options come from/i }),
      ).toHaveTextContent('Fixed list');
      expect(screen.getByLabelText(/options \(comma-separated\)/i)).toBeInTheDocument();
    });

    it('TC-1: switching to "This journey" replaces the options input with a context-provider picker and clears options', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const fields: RuleParameterField[] = [
        {
          key: 'targetComponentCode',
          label: 'Target component',
          type: 'select',
          required: true,
          options: ['x'],
        },
      ];
      render(
        <ControlledEditor
          initialFields={fields}
          onChange={onChange}
          contextProviders={contextProviders}
          apiLookupProviders={apiLookupProviders}
        />,
      );

      await user.click(screen.getByRole('combobox', { name: /where do the options come from/i }));
      await user.click(screen.getByRole('option', { name: 'This journey' }));

      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({
          key: 'targetComponentCode',
          valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
          options: undefined,
        }),
      ]);
      expect(screen.queryByLabelText(/options \(comma-separated\)/i)).not.toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /journey source/i })).toBeInTheDocument();
    });

    it('TC-2: a `planned` API lookup provider is labelled but still selectable', async () => {
      const user = userEvent.setup();
      const fields: RuleParameterField[] = [
        {
          key: 'sku',
          label: 'SKU',
          type: 'select',
          required: true,
          valueSource: { kind: 'API_LOOKUP', apiProvider: 'PRODUCT_CATALOG' },
        },
      ];
      render(
        <ParameterFieldsEditor
          fields={fields}
          onChange={vi.fn()}
          contextProviders={contextProviders}
          apiLookupProviders={apiLookupProviders}
        />,
      );

      const picker = screen.getByRole('combobox', { name: /live-lookup provider/i });
      expect(picker).toHaveTextContent('Product catalog (not available yet)');

      await user.click(picker);
      const option = screen.getByRole('option', { name: /product catalog \(not available yet\)/i });
      expect(option).not.toHaveAttribute('aria-disabled');
    });

    it('clears a dangling valueSource when the field type changes away from "select"', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const fields: RuleParameterField[] = [
        {
          key: 'targetComponentCode',
          label: 'Target component',
          type: 'select',
          required: true,
          valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
        },
      ];
      render(<ParameterFieldsEditor fields={fields} onChange={onChange} />);

      await user.click(screen.getByRole('combobox', { name: /^type$/i }));
      await user.click(screen.getByRole('option', { name: 'Text' }));

      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'string', valueSource: undefined }),
      ]);
    });
  });
});
