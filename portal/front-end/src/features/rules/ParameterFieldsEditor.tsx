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
import type {
  FieldApiLookupProvider,
  FieldContextProvider,
  RuleParameterField,
  RuleParameterType,
} from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { Input } from '../../components/Input';
import { Select, type SelectOption } from '../../components/Select';
import { ruleFieldRoleLabel } from './ruleFieldRole';

const TYPE_OPTIONS: SelectOption[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Choice list' },
];

/**
 * T-125 — the field builder's "Where do the options come from?" choice for a `select` field
 * (`13-REWARD-MASTER-VALUE-SOURCES.md` §3). `STATIC_LIST` is a picker-only concept: it is never
 * written to the wire (see {@link RuleParameterField.valueSource}'s own comment — there is no
 * `STATIC_LIST` variant of `valueSource`), it is simply "no `valueSource` at all" for the
 * purposes of this one control.
 */
const SOURCE_KIND_OPTIONS: SelectOption[] = [
  { value: 'STATIC_LIST', label: 'Fixed list' },
  { value: 'CONTEXT_LOOKUP', label: 'This journey' },
  { value: 'API_LOOKUP', label: 'Live lookup' },
];

type SourceKind = 'STATIC_LIST' | 'CONTEXT_LOOKUP' | 'API_LOOKUP';

function sourceKindOf(field: RuleParameterField): SourceKind {
  return field.valueSource?.kind ?? 'STATIC_LIST';
}

/**
 * Switching the source kind always leaves the field in exactly one of the three states, even
 * though `ruleParameterFieldSchema` itself would tolerate `options` and `valueSource` together
 * (T-122's own comment: *"a fixed list plus a provider is a meaningful authoring state — T-125
 * decides how to present it"*). This picker's presentation is "exactly one at a time" — simpler
 * to author against, and nothing in the task's test cases asks for the combined state.
 */
function sourceKindPatch(
  next: string,
  contextProviders: readonly FieldContextProvider[],
  apiLookupProviders: readonly FieldApiLookupProvider[],
): Partial<RuleParameterField> {
  if (next === 'CONTEXT_LOOKUP') {
    return {
      valueSource: {
        kind: 'CONTEXT_LOOKUP',
        contextProvider: contextProviders[0]?.providerCode ?? '',
      },
      options: undefined,
    };
  }
  if (next === 'API_LOOKUP') {
    return {
      valueSource: { kind: 'API_LOOKUP', apiProvider: apiLookupProviders[0]?.providerCode ?? '' },
      options: undefined,
    };
  }
  return { valueSource: undefined };
}

/** `status !== 'active'` is labelled, never hidden — implementation note 1: *"grey out or label
 * `planned` ones as 'not available yet' rather than hiding them, so the Super Admin can still
 * author against one"*. Never `disabled` on the option itself: `Select` refuses to commit a
 * disabled option (TC-2 requires it stay pickable). */
function contextProviderOptions(providers: readonly FieldContextProvider[]): SelectOption[] {
  return providers.map((provider) => ({
    value: provider.providerCode,
    label: provider.status === 'active' ? provider.name : `${provider.name} (inactive)`,
  }));
}

function apiLookupProviderOptions(providers: readonly FieldApiLookupProvider[]): SelectOption[] {
  return providers.map((provider) => ({
    value: provider.providerCode,
    label: provider.status === 'planned' ? `${provider.name} (not available yet)` : provider.name,
  }));
}

export interface ParameterFieldsEditorProps {
  fields: readonly RuleParameterField[];
  onChange: (fields: RuleParameterField[]) => void;
  disabled?: boolean;
  /**
   * T-115 — the `key`s the currently previewed Resolver (T-114's `rule_resolvers.
   * resolver_input_field_keys`) would consume as its own lookup input, so each row can show a
   * live, read-only "Resolver input" / "Compared value" badge as the Super Admin types a `key`
   * or changes the previewed Resolver. Purely a client-side derivation for authoring UX — the
   * server independently computes the same `role` from whichever resolver a rule's version is
   * actually wired to (T-114 `RulesService`), and this prop never reaches the write payload
   * `AddRuleModal`/`EditRuleModal` submit. Defaults to `[]`: no resolver previewed → every field
   * reads as "Compared value".
   */
  resolverInputFieldKeys?: readonly string[];
  /** T-125 — options for the "This journey" value-source choice. `[]` while loading or if none
   * are registered; the picker still renders, just with nothing to choose yet. */
  contextProviders?: readonly FieldContextProvider[];
  /** T-125 — options for the "Live lookup" value-source choice. */
  apiLookupProviders?: readonly FieldApiLookupProvider[];
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

export function ParameterFieldsEditor({
  fields,
  onChange,
  disabled,
  resolverInputFieldKeys = [],
  contextProviders = [],
  apiLookupProviders = [],
}: ParameterFieldsEditorProps) {
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
      <div className="flex items-start justify-between gap-4">
        <h3 className="text-sm font-semibold text-slate-900">
          Parameter Fields
          <span className="ml-2 font-normal text-slate-400">
            — what the Maker fills in when applying this rule to a tracker component
          </span>
        </h3>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={addField}
          disabled={disabled}
          className="shrink-0 whitespace-nowrap"
        >
          <Plus className="size-4" aria-hidden="true" />
          Add field
        </Button>
      </div>
      {/* T-160 — this explanatory copy previously existed only as a source comment on the
          `role` badge below, never actually rendered to the screen (mockup:
          `super-admin-rules-rewards-theme-preview.html:439-443`). Wording kept verbatim. */}
      <p className="text-xs text-slate-500">
        Role matters: <strong className="font-medium text-slate-700">Compared value</strong> is
        checked against the resolved fact above, using the Maker&apos;s chosen operator.{' '}
        <strong className="font-medium text-slate-700">Resolver input</strong> instead parameterizes
        the lookup itself — e.g. which sibling component to check.
      </p>

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
          <div className="col-span-2">
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
              onChange={(value) => {
                // A `valueSource` (T-122) only means anything on a `select` field — leaving
                // one behind while switching away would 400 at submit with no visible cause,
                // since neither `AddRuleModal` nor `EditRuleModal` maps a nested `parameters`
                // issue onto a form control.
                const type = value as RuleParameterType;
                updateField(index, type === 'select' ? { type } : { type, valueSource: undefined });
              }}
              disabled={disabled}
            />
          </div>
          {/* T-160 — `col-span-2`, not `-1`: at `-1` the "Required" label visibly ran into the
              role Badge in the next column at every modal width tried, `xl` included. */}
          <div className="col-span-2 pt-2">
            <Checkbox
              label="Required"
              checked={field.required}
              onChange={(event) => updateField(index, { required: event.target.checked })}
              disabled={disabled}
            />
          </div>
          <div className="col-span-2 pt-2">
            {/* T-115 — read-only, computed from the previewed Resolver's
                `resolverInputFieldKeys`; there is no control here for a reason (13-REWARD-
                MASTER-VALUE-SOURCES.md §2: "role is never client-writable"). */}
            <Badge tone={resolverInputFieldKeys.includes(field.key) ? 'primary' : 'slate'}>
              {ruleFieldRoleLabel(
                resolverInputFieldKeys.includes(field.key) ? 'resolver_input' : 'compare_value',
              )}
            </Badge>
          </div>
          {/* T-160 — shrunk from `col-span-2` to `-1` (an icon-only button needs far less room
              than that) to give the freed column back to "Required", above. */}
          <div className="col-span-1 flex justify-end pt-1">
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
            <div className="col-span-12 grid grid-cols-12 gap-2">
              <div className="col-span-4">
                <Select
                  label="Where do the options come from?"
                  options={SOURCE_KIND_OPTIONS}
                  value={sourceKindOf(field)}
                  onChange={(value) =>
                    updateField(index, sourceKindPatch(value, contextProviders, apiLookupProviders))
                  }
                  disabled={disabled}
                />
              </div>

              {sourceKindOf(field) === 'STATIC_LIST' && (
                <div className="col-span-8">
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

              {sourceKindOf(field) === 'CONTEXT_LOOKUP' && (
                <div className="col-span-8">
                  <Select
                    label="Journey source"
                    placeholder="Select a journey source…"
                    options={contextProviderOptions(contextProviders)}
                    value={
                      field.valueSource?.kind === 'CONTEXT_LOOKUP'
                        ? field.valueSource.contextProvider
                        : null
                    }
                    onChange={(value) =>
                      updateField(index, {
                        valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: value },
                      })
                    }
                    disabled={disabled}
                  />
                </div>
              )}

              {sourceKindOf(field) === 'API_LOOKUP' && (
                <div className="col-span-8">
                  <Select
                    label="Live-lookup provider"
                    placeholder="Select a live-lookup provider…"
                    options={apiLookupProviderOptions(apiLookupProviders)}
                    value={
                      field.valueSource?.kind === 'API_LOOKUP'
                        ? field.valueSource.apiProvider
                        : null
                    }
                    onChange={(value) =>
                      updateField(index, {
                        valueSource: { kind: 'API_LOOKUP', apiProvider: value },
                      })
                    }
                    disabled={disabled}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
