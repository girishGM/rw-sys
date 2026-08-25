/**
 * T-037 step 4 — `DynamicParameterForm` (04-FRONTEND.md §5.4, implementation note 9).
 *
 * > *"`DynamicParameterForm` builds a Zod schema at runtime from `rule_versions.parameters`.
 * > **Re-validate on the server against the same version's schema** — client-built validation is
 * > trivially bypassed."*
 *
 * Both halves of that sentence matter, and this component is the first half only. It renders a
 * form from whatever fields a rule declares — so *"a new rule needs no front-end change"* (§5.4)
 * — and validates against `buildRuleValueSchema`, the **shared** function
 * `packages/shared/src/campaign.schema.ts` exports and `bindings.service.ts` re-validates with
 * server-side. There is exactly one definition of what a valid value set is; this is a rendering
 * of it, not a second opinion about it.
 *
 * The consequence worth being explicit about: **nothing here is a security control.** TC-17
 * bypasses this form entirely and expects the server to refuse; the value of validating here is
 * that a maker sees "minimum spend must be at least 10" next to the field instead of a round
 * trip later.
 *
 * ### Why no `react-hook-form`
 *
 * 04-FRONTEND.md §9 names React Hook Form + a Zod resolver for forms, and every static form in
 * this app uses it. This one is different in kind: its field set is data, not code, so there is
 * no typed shape to register against and every `register()` call would be a string index anyway.
 * A plain controlled `Record<string, unknown>` plus one `safeParse` on change is both smaller and
 * exactly as strict — and it keeps the parse using the shared schema rather than a resolver
 * wrapper around it. Noted as a deliberate deviation in the T-037 completion report.
 */
import { useMemo } from 'react';
import type { RuleParameterField, RuleParameters } from '@reward-portal/shared';
import { Checkbox } from '../../components/Checkbox';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { validateValues } from './ruleValues';

export interface DynamicParameterFormProps {
  /** The rule's own meta-schema — `rule_versions.parameters`, or the rule's when unversioned. */
  readonly parameters: RuleParameters;
  readonly values: Record<string, unknown>;
  readonly onChange: (values: Record<string, unknown>) => void;
  readonly disabled?: boolean;
  /** Field-level errors the **server** returned, keyed by parameter key. Rendered alongside the
   * client's own, because a server error the maker cannot see is a form that looks broken. */
  readonly serverErrors?: Readonly<Record<string, string>>;
  readonly idPrefix?: string;
}

export function DynamicParameterForm({
  parameters,
  values,
  onChange,
  disabled,
  serverErrors,
  idPrefix = 'param',
}: DynamicParameterFormProps) {
  // Recomputed only when the values or the schema change — a rule with ten fields (TC-20)
  // otherwise re-parses on every keystroke of every other field.
  const clientErrors = useMemo(() => validateValues(parameters, values), [parameters, values]);

  if (parameters.fields.length === 0) {
    return <p className="text-sm text-slate-500">This rule takes no parameters.</p>;
  }

  function set(key: string, value: unknown): void {
    const next = { ...values };
    // Clearing an optional field must **remove** the key, not store `''`/`null`: the shared
    // schema treats "absent" as not-supplied and would reject an empty string against a
    // `number`. This is the one place the two representations meet.
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    onChange(next);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {parameters.fields.map((field) => (
        <ParameterField
          key={field.key}
          field={field}
          value={values[field.key]}
          error={serverErrors?.[field.key] ?? clientErrors[field.key]}
          disabled={disabled}
          idPrefix={idPrefix}
          onChange={(value) => {
            set(field.key, value);
          }}
        />
      ))}
    </div>
  );
}

interface ParameterFieldProps {
  readonly field: RuleParameterField;
  readonly value: unknown;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly idPrefix: string;
  readonly onChange: (value: unknown) => void;
}

function ParameterField({
  field,
  value,
  error,
  disabled,
  idPrefix,
  onChange,
}: ParameterFieldProps) {
  const id = `${idPrefix}-${field.key}`;
  const label = field.required ? `${field.label} *` : field.label;

  switch (field.type) {
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          label={label}
          hint={field.helpText}
          error={error}
          disabled={disabled}
          min={field.min}
          max={field.max}
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(event) => {
            const raw = event.target.value;
            // `Number('')` is 0, which would silently turn "cleared" into "zero" — and zero is a
            // meaningful minimum spend. Empty stays empty.
            onChange(raw === '' ? undefined : Number(raw));
          }}
        />
      );

    case 'boolean':
      return (
        <Checkbox
          id={id}
          label={label}
          error={error}
          disabled={disabled}
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
      );

    case 'date':
      return (
        <Input
          id={id}
          type="date"
          label={label}
          hint={field.helpText}
          error={error}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );

    case 'select':
      return (
        <Select
          label={label}
          error={error}
          disabled={disabled}
          value={typeof value === 'string' ? value : null}
          options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
          onChange={onChange}
        />
      );

    case 'string':
    default:
      return (
        <Input
          id={id}
          type="text"
          label={label}
          hint={field.helpText}
          error={error}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
  }
}
