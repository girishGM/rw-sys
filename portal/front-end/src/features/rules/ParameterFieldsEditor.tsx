/**
 * T-031 — the parameter-schema builder (04-FRONTEND.md §4: "Rules list / editor | super_admin
 * write | Category → sub-category → expression + parameter schema builder").
 *
 * Edits a `RuleParameters` value (`packages/shared/src/rule.schema.ts`'s `ruleParametersSchema`
 * — the same meta-schema the back end validates `parameters` against on save) as a list of
 * rows: one row per field a Maker will later fill in at campaign-creation time. Kept a plain,
 * controlled component (no `react-hook-form` field array) since it is embedded inside both
 * `AddRuleModal` and `EditRuleModal`'s own forms as a single opaque value.
 */
import { Plus, Trash2 } from 'lucide-react';
import type { RuleParameterField, RuleParameterType } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { Input } from '../../components/Input';
import { Select, type SelectOption } from '../../components/Select';

const TYPE_OPTIONS: SelectOption[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Choice list' },
];

export interface ParameterFieldsEditorProps {
  fields: readonly RuleParameterField[];
  onChange: (fields: RuleParameterField[]) => void;
  disabled?: boolean;
}

function emptyField(): RuleParameterField {
  return { key: '', label: '', type: 'string', required: false };
}

/** Every distinct, non-blank `key` — used to flag the client-side half of TC-14 (duplicate keys
 * fail the same meta-schema the server enforces) before the form is even submitted. */
function duplicateKeys(fields: readonly RuleParameterField[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const field of fields) {
    if (field.key === '') continue;
    if (seen.has(field.key)) duplicates.add(field.key);
    seen.add(field.key);
  }
  return duplicates;
}

export function ParameterFieldsEditor({ fields, onChange, disabled }: ParameterFieldsEditorProps) {
  const duplicates = duplicateKeys(fields);

  function updateField(index: number, patch: Partial<RuleParameterField>): void {
    const next = fields.map((field, i) => (i === index ? { ...field, ...patch } : field));
    onChange(next as RuleParameterField[]);
  }

  function removeField(index: number): void {
    onChange(fields.filter((_field, i) => i !== index) as RuleParameterField[]);
  }

  function addField(): void {
    onChange([...fields, emptyField()] as RuleParameterField[]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          Parameters
          <span className="ml-2 font-normal text-slate-400">
            the dynamic values a Maker supplies at campaign time
          </span>
        </h3>
        <Button type="button" variant="secondary" size="sm" onClick={addField} disabled={disabled}>
          <Plus className="size-4" aria-hidden="true" />
          Add field
        </Button>
      </div>

      {fields.length === 0 && (
        <p className="text-sm text-slate-500">
          No parameters yet — this rule takes no dynamic values.
        </p>
      )}

      {fields.map((field, index) => (
        <div
          key={index}
          className="grid grid-cols-12 items-start gap-2 rounded-card border border-slate-200 p-3"
        >
          <div className="col-span-3">
            <Input
              label="Key"
              hideLabel
              placeholder="minSpend"
              value={field.key}
              onChange={(event) => updateField(index, { key: event.target.value })}
              error={duplicates.has(field.key) ? 'Duplicate key' : undefined}
              disabled={disabled}
            />
          </div>
          <div className="col-span-3">
            <Input
              label="Label"
              hideLabel
              placeholder="Minimum spend"
              value={field.label}
              onChange={(event) => updateField(index, { label: event.target.value })}
              disabled={disabled}
            />
          </div>
          <div className="col-span-2">
            <Select
              label="Type"
              hideLabel
              options={TYPE_OPTIONS}
              value={field.type}
              onChange={(value) => updateField(index, { type: value as RuleParameterType })}
              disabled={disabled}
            />
          </div>
          <div className="col-span-2 pt-2">
            <Checkbox
              label="Required"
              checked={field.required}
              onChange={(event) => updateField(index, { required: event.target.checked })}
              disabled={disabled}
            />
          </div>
          <div className="col-span-2 flex justify-end pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeField(index)}
              disabled={disabled}
              aria-label="Remove field"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {field.type === 'select' && (
            <div className="col-span-12">
              <Input
                label="Options (comma-separated)"
                placeholder="gold, silver, bronze"
                value={(field.options ?? []).join(', ')}
                onChange={(event) =>
                  updateField(index, {
                    options: event.target.value
                      .split(',')
                      .map((option) => option.trim())
                      .filter((option) => option.length > 0),
                  })
                }
                disabled={disabled}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
