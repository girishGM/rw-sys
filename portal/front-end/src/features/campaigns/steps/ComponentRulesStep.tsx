/**
 * T-037 step 4 — *"Component rules: supply DYNAMIC VALUES, grouped under the component they
 * govern"* (04-FRONTEND.md §5.4).
 *
 * > *"Rules are chosen in step 3 where their context is visible; their **values** are supplied in
 * > step 4, grouped under the owning component. A maker entering 'minimum spend' can see which
 * > step of the customer journey it governs."*
 *
 * The grouping is the point, so the layout is tracker → component → rule, never a flat list of
 * rules. Each rule's fields come from `DynamicParameterForm`, built from that rule's own
 * `parameters` — so a rule Super Admin adds tomorrow renders here with no front-end change.
 *
 * Rules may also be **added** here rather than only in step 3: a maker who reaches step 4 and
 * finds a component with no rule should not have to go back a step to fix it, and the picker is
 * the same country-scoped list either way (TC-14).
 */
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  Journey,
  JourneyComponent,
  RuleOption,
  RuleParameterField,
  RuleParameters,
} from '@reward-portal/shared';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card, CardBody, CardHeader } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { Input } from '../../../components/Input';
import { Select, type SelectOption } from '../../../components/Select';
import { DynamicParameterForm } from '../DynamicParameterForm';
import {
  useApiLookupOptions,
  useContextLookupOptions,
  FIELD_LOOKUP_NOT_AVAILABLE_STATUS,
} from '../ruleValues';
import { componentErrorKey, OPERATOR_ERROR_FIELD } from './ruleErrorKeys';

/** Sentinel `Select` value meaning "no filter" — `SelectProps.value` is `string | null`, and an
 * unset filter renders as the placeholder rather than a real option, so this never collides with
 * a real `categoryId`/`subCategoryId` (both always positive integers). */
const NO_FILTER = '';

/** T-148 — the component-level "rules combine" values, the same three `trackers.completion_logic`
 * already uses one level up (`JourneyStep`'s own Completion logic picker). */
export type RuleLogic = NonNullable<JourneyComponent['ruleLogic']>;

export interface ComponentRulesStepProps {
  readonly journey: Journey | undefined;
  readonly ruleOptions: readonly RuleOption[];
  readonly disabled?: boolean;
  readonly onBindRule: (componentId: number, ruleId: number) => void;
  readonly onUnbindRule: (bindingId: number) => void;
  readonly onSaveValues: (bindingId: number, values: Record<string, unknown>) => void;
  /**
   * T-148 — the comparison operator for one bound rule (`tracker_component_rules.operator`).
   * Saved on selection rather than through `onSaveValues`' dirty/save cycle: it is one atomic
   * choice from a fixed list, with nothing to type and nothing to confirm.
   */
  readonly onSaveOperator: (bindingId: number, operator: string) => void;
  /**
   * T-148 — how one component's own bound rules combine. `ruleThreshold` is `null` for anything
   * but `'n_of'` and is always sent **with** `ruleLogic`, never on its own: the shared contract's
   * two-sided refine ("n_of requires a threshold, anything else forbids one") can only judge a
   * request that carries both.
   */
  readonly onSaveRuleLogic: (
    componentId: number,
    ruleLogic: RuleLogic,
    ruleThreshold: number | null,
  ) => void;
  /** Server-side field errors, keyed `${bindingId}.${parameterKey}` — TC-17's 400 rendered on
   * the field that caused it rather than as a toast with no context. T-148 adds two more keys in
   * the same record: `${bindingId}.operator` and {@link componentErrorKey}. */
  readonly serverErrors?: Readonly<Record<string, string>>;
}

export function ComponentRulesStep({
  journey,
  ruleOptions,
  disabled,
  onBindRule,
  onUnbindRule,
  onSaveValues,
  onSaveOperator,
  onSaveRuleLogic,
  serverErrors,
}: ComponentRulesStepProps) {
  const trackers = journey?.trackers ?? [];

  if (trackers.length === 0) {
    return (
      <EmptyState
        message="No journey yet"
        description="Build at least one tracker with a step in the journey builder first."
      />
    );
  }

  return (
    <div className="grid gap-5">
      {trackers.map((tracker) => (
        <Card key={tracker.id}>
          <CardHeader>
            <h3 className="text-sm font-semibold text-slate-800">{tracker.name}</h3>
          </CardHeader>
          <CardBody className="grid gap-5">
            {tracker.components.length === 0 && (
              <p className="text-sm text-slate-500">This tracker has no steps yet.</p>
            )}
            {tracker.components.map((component) => (
              <section key={component.id} className="rounded-lg border border-slate-200 p-4">
                <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <h4 className="text-sm font-medium text-slate-800">
                    {component.sequenceOrder}. {component.name}
                  </h4>
                  <div className="flex items-center gap-2">
                    {component.rules.length === 0 && <Badge tone="warning">no rule</Badge>}
                    <ComponentRuleLogic
                      componentId={component.id}
                      ruleLogic={component.ruleLogic}
                      ruleThreshold={component.ruleThreshold}
                      ruleCount={component.rules.length}
                      disabled={disabled}
                      error={serverErrors?.[componentErrorKey(component.id)]}
                      onSave={onSaveRuleLogic}
                    />
                  </div>
                </header>

                {component.rules.length === 0 && (
                  <p className="mb-3 text-sm text-slate-500">
                    A step with no rule can never complete, so the campaign cannot be submitted
                    until this has one.
                  </p>
                )}

                <div className="grid gap-5">
                  {component.rules.map((rule) => (
                    <RuleValues
                      key={rule.id}
                      bindingId={rule.id}
                      title={rule.ruleName === '' ? rule.ruleCode : rule.ruleName}
                      versionNo={rule.ruleVersionNo}
                      parameters={rule.parameters}
                      values={rule.values}
                      operator={rule.operator}
                      operatorOptions={operatorsFor(ruleOptions, rule.ruleId)}
                      trackerId={tracker.id}
                      componentId={component.id}
                      disabled={disabled}
                      serverErrors={pickErrors(serverErrors, rule.id)}
                      onSave={(values) => {
                        onSaveValues(rule.id, values);
                      }}
                      onSaveOperator={(operator) => {
                        onSaveOperator(rule.id, operator);
                      }}
                      onRemove={() => {
                        onUnbindRule(rule.id);
                      }}
                    />
                  ))}

                  <AddRule
                    options={ruleOptions.filter(
                      (option) => !component.rules.some((rule) => rule.ruleId === option.ruleId),
                    )}
                    disabled={disabled}
                    onAdd={(ruleId) => {
                      onBindRule(component.id, ruleId);
                    }}
                  />
                </div>
              </section>
            ))}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function pickErrors(
  errors: Readonly<Record<string, string>> | undefined,
  bindingId: number,
): Record<string, string> {
  if (errors === undefined) return {};
  const prefix = `${String(bindingId)}.`;
  const picked: Record<string, string> = {};
  for (const [key, message] of Object.entries(errors)) {
    if (key.startsWith(prefix)) picked[key.slice(prefix.length)] = message;
  }
  return picked;
}

/**
 * T-148 — the operators a bound rule may be compared with, read off the rule picker's own row for
 * that rule (`ruleOptionSchema.defaultOperators`, T-147).
 *
 * A rule the picker no longer offers — unbound from this country since it was bound, or bound
 * against a version that has since been superseded — yields an empty list, which renders as the
 * disabled "no operators" state rather than as a missing control (TC-2).
 *
 * **Known limitation, by contract.** `defaultOperators` here belongs to the rule's *currently
 * active* version for this country, while the server validates against the version *pinned to
 * this binding* (`BindingsService#assertOperatorAllowed`). The two are the same version until a
 * new one is assigned mid-campaign, and `ComponentRule` carries no `defaultOperators` of its own
 * to close the gap. That divergence is exactly what the operator's own server-error slot below is
 * for: the 400 lands on this control, not in a toast (TC-7).
 */
function operatorsFor(options: readonly RuleOption[], ruleId: number): readonly string[] {
  return options.find((option) => option.ruleId === ruleId)?.defaultOperators ?? [];
}

/**
 * T-148 — *"Rules combine: ALL must pass / ANY may pass / N of X must pass"*, per component
 * (`maker-apply-rule-mockup.html`'s `new`-badged component header control).
 *
 * `null` reads as `'all'`, which is what T-147's own backend does with the same column: a
 * component nobody has set a combination rule on behaves exactly as it always has (TC-4).
 *
 * Draft-then-save, mirroring `RuleValues`' own dirty/save cycle in this file rather than
 * `JourneyStep`'s save-per-keystroke tracker picker: `'n_of'` is only a legal request once it has
 * a threshold, so firing on the `Select` alone would send a request the shared contract's refine
 * is guaranteed to reject. All state is per instance, so one component's draft can never reach a
 * sibling's (TC-8) — the same isolation `AddRule`'s filter state already has.
 */
function ComponentRuleLogic({
  componentId,
  ruleLogic,
  ruleThreshold,
  ruleCount,
  disabled,
  error,
  onSave,
}: {
  readonly componentId: number;
  readonly ruleLogic: RuleLogic | null;
  readonly ruleThreshold: number | null;
  readonly ruleCount: number;
  readonly disabled?: boolean;
  readonly error?: string;
  readonly onSave: (
    componentId: number,
    ruleLogic: RuleLogic,
    ruleThreshold: number | null,
  ) => void;
}) {
  const savedLogic: RuleLogic = ruleLogic ?? 'all';
  const [logic, setLogic] = useState<RuleLogic>(savedLogic);
  // Held as text, not a number: an `<input type="number">` legitimately passes through the empty
  // string while the maker clears it to retype, and `Number('')` is `0` — a value the contract
  // rejects and the maker never typed.
  const [threshold, setThreshold] = useState<string>(
    ruleThreshold === null ? '' : String(ruleThreshold),
  );

  const parsedThreshold = /^\d+$/.test(threshold) ? Number(threshold) : null;
  const thresholdValid = logic !== 'n_of' || (parsedThreshold !== null && parsedThreshold >= 1);
  const dirty =
    logic !== savedLogic || (logic === 'n_of' && parsedThreshold !== (ruleThreshold ?? null));

  return (
    <div className="flex flex-wrap items-end justify-end gap-2">
      <Select
        label="Rules combine"
        className="w-56"
        value={logic}
        disabled={disabled}
        error={error}
        options={[
          { value: 'all', label: 'ALL must pass' },
          { value: 'any', label: 'ANY may pass' },
          { value: 'n_of', label: `N of ${String(ruleCount)} must pass` },
        ]}
        onChange={(value) => {
          const next = value as RuleLogic;
          setLogic(next);
          // Anything but `n_of` forbids a threshold, so leaving the old one in the draft would
          // make the next save unrepresentable rather than merely hidden (TC-5).
          if (next !== 'n_of') setThreshold('');
        }}
      />
      {logic === 'n_of' && (
        <Input
          type="number"
          min={1}
          max={Math.max(ruleCount, 1)}
          className="w-24"
          label="N"
          value={threshold}
          disabled={disabled}
          onChange={(event) => {
            setThreshold(event.target.value);
          }}
        />
      )}
      {dirty && thresholdValid && (
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() => {
            onSave(componentId, logic, logic === 'n_of' ? parsedThreshold : null);
          }}
        >
          Save rule logic
        </Button>
      )}
    </div>
  );
}

interface RuleValuesProps {
  readonly bindingId: number;
  readonly title: string;
  readonly versionNo: number | null;
  readonly parameters: RuleParameters;
  readonly values: Record<string, unknown>;
  /** T-148 — the comparison operator already saved on this binding, `null` until one is chosen. */
  readonly operator: string | null;
  /** T-148 — what this rule's pinned version allows; empty renders the control disabled. */
  readonly operatorOptions: readonly string[];
  /** T-125 — a `CONTEXT_LOOKUP` field's own context (`SIBLING_COMPONENTS`'s "only earlier
   * components" filter, `13-REWARD-MASTER-VALUE-SOURCES.md` §3): which tracker this binding's
   * component sits in, and which component to exclude from its own dropdown. Every component
   * this step renders already has a real id — there is no "brand-new, unplaced component" case
   * here the way T-123's own endpoint documents for a different caller. */
  readonly trackerId: number;
  readonly componentId: number;
  readonly disabled?: boolean;
  readonly serverErrors: Record<string, string>;
  readonly onSave: (values: Record<string, unknown>) => void;
  readonly onSaveOperator: (operator: string) => void;
  readonly onRemove: () => void;
}

function RuleValues({
  bindingId,
  title,
  versionNo,
  parameters,
  values,
  operator,
  operatorOptions,
  trackerId,
  componentId,
  disabled,
  serverErrors,
  onSave,
  onSaveOperator,
  onRemove,
}: RuleValuesProps) {
  const [draft, setDraft] = useState<Record<string, unknown>>(values);
  const dirty = JSON.stringify(draft) !== JSON.stringify(values);
  /**
   * T-148 — the operator the maker has chosen, which is not necessarily the one the server has
   * accepted yet. Held locally so the control shows the choice immediately (the save is a round
   * trip) and, crucially, still shows it when the save is *rejected* — a select that snapped back
   * to the old value would leave `serverErrors.operator` pointing at a choice no longer on screen.
   */
  const [operatorDraft, setOperatorDraft] = useState<string | null>(operator);

  // T-125 — a field with a `valueSource` (T-122) is rendered by `ValueSourceField` below, never
  // by `DynamicParameterForm`: that component's own `select` case only knows the hand-typed
  // `options` array, and the task's own scope is explicit that its plain fixed-list path stays
  // "already works, untouched". Splitting the field list here, rather than teaching
  // `DynamicParameterForm` a fourth field type, is what keeps that path byte-for-byte unchanged.
  const plainFields = useMemo(
    () => parameters.fields.filter((field) => field.valueSource === undefined),
    [parameters],
  );
  const sourceFields = useMemo(
    () => parameters.fields.filter((field) => field.valueSource !== undefined),
    [parameters],
  );

  function setValue(key: string, value: unknown): void {
    setDraft((current) => {
      const next = { ...current };
      if (value === undefined || value === '') delete next[key];
      else next[key] = value;
      return next;
    });
  }

  return (
    <div className="grid gap-3 rounded-md bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-800">
          {title}
          {versionNo !== null && (
            <span className="ml-2 text-xs font-normal text-slate-500">v{versionNo}</span>
          )}
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRemove}>
          <Trash2 className="size-4" aria-hidden="true" />
          Remove
        </Button>
      </div>

      {/* T-148 — the comparison operator, a row of its own above the parameter fields rather than
          a fourth field type inside `DynamicParameterForm`: it is not one of the rule's own
          `parameters`, it is the comparison the runtime engine applies to them. Disabled with an
          explanatory placeholder rather than hidden when the pinned version allows none, so a
          maker can see *why* nothing is selectable — the same choice `ApiLookupField` makes for
          its own "Not available yet" state (TC-2). */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Operator"
          value={operatorDraft}
          disabled={disabled || operatorOptions.length === 0}
          error={serverErrors[OPERATOR_ERROR_FIELD]}
          placeholder={
            operatorOptions.length === 0
              ? "No operators configured for this rule's version"
              : 'Select…'
          }
          options={operatorOptions.map((code) => ({ value: code, label: code }))}
          onChange={(value) => {
            setOperatorDraft(value);
            onSaveOperator(value);
          }}
        />
      </div>

      {parameters.fields.length === 0 && (
        <p className="text-sm text-slate-500">This rule takes no parameters.</p>
      )}

      {sourceFields.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {sourceFields.map((field) => (
            <ValueSourceField
              key={field.key}
              field={field}
              value={draft[field.key]}
              error={serverErrors[field.key]}
              disabled={disabled}
              trackerId={trackerId}
              componentId={componentId}
              onChange={(value) => {
                setValue(field.key, value);
              }}
            />
          ))}
        </div>
      )}

      {plainFields.length > 0 && (
        <DynamicParameterForm
          parameters={{ fields: plainFields }}
          values={draft}
          disabled={disabled}
          serverErrors={serverErrors}
          idPrefix={`rule-${String(bindingId)}`}
          onChange={setDraft}
        />
      )}

      {dirty && (
        <div>
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onSave(draft);
            }}
          >
            Save values
          </Button>
        </div>
      )}
    </div>
  );
}

interface ValueSourceFieldProps {
  readonly field: RuleParameterField;
  readonly value: unknown;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly trackerId: number;
  readonly componentId: number;
  readonly onChange: (value: string) => void;
}

/** T-125 — renders whichever of the two value-source kinds (T-122) `field.valueSource` declares.
 * A field with neither is not routed here at all (see `RuleValues`'s own split above). */
function ValueSourceField(props: ValueSourceFieldProps) {
  const { field } = props;
  const source = field.valueSource;
  if (source === undefined) return null;

  if (source.kind === 'CONTEXT_LOOKUP') {
    return <ContextLookupField {...props} contextProvider={source.contextProvider} />;
  }
  return <ApiLookupField {...props} apiProvider={source.apiProvider} />;
}

function fieldLabel(field: RuleParameterField): string {
  return field.required ? `${field.label} *` : field.label;
}

function selectValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * `CONTEXT_LOOKUP`, `SIBLING_COMPONENTS` (and any future context provider, per implementation
 * note 1: *"any future context provider this task did not anticipate — returns the full,
 * unfiltered list"*) — no network call the Maker waits on beyond this one request; T-123's own
 * endpoint reads the campaign draft server-side.
 */
function ContextLookupField({
  field,
  value,
  error,
  disabled,
  trackerId,
  componentId,
  contextProvider,
  onChange,
}: ValueSourceFieldProps & { readonly contextProvider: string }) {
  const lookup = useContextLookupOptions(contextProvider, trackerId, componentId);
  const options: SelectOption[] = (lookup.data ?? []).map((option) => ({
    value: String(option.value),
    label: option.label,
  }));

  return (
    <Select
      label={fieldLabel(field)}
      error={error ?? (lookup.isError ? lookup.error.message : undefined)}
      disabled={disabled || lookup.isLoading}
      value={selectValue(value)}
      options={options}
      placeholder={lookup.isLoading ? 'Loading…' : 'Select…'}
      onChange={onChange}
    />
  );
}

/**
 * `API_LOOKUP` — implementation note 2: disabled with a loading label while the call is in
 * flight, a clear disabled "not available yet" state on the `501` a `planned` provider always
 * answers with (never a spinner that never resolves), populated and enabled on success.
 */
function ApiLookupField({
  field,
  value,
  error,
  disabled,
  apiProvider,
  onChange,
}: ValueSourceFieldProps & { readonly apiProvider: string }) {
  const lookup = useApiLookupOptions(apiProvider);
  const notAvailable = lookup.isError && lookup.error.status === FIELD_LOOKUP_NOT_AVAILABLE_STATUS;

  if (notAvailable) {
    return (
      <Select
        label={fieldLabel(field)}
        error={error}
        disabled
        value={null}
        options={[]}
        placeholder="Not available yet"
        onChange={() => {
          // Disabled — never reachable, `Select` never commits from a closed/disabled trigger.
        }}
      />
    );
  }

  const options: SelectOption[] = (lookup.data ?? []).map((option) => ({
    value: String(option.value),
    label: option.label,
  }));

  return (
    <Select
      label={fieldLabel(field)}
      error={error ?? (lookup.isError ? lookup.error.message : undefined)}
      disabled={disabled || lookup.isLoading}
      value={selectValue(value)}
      options={options}
      placeholder={lookup.isLoading ? 'Loading…' : 'Select…'}
      onChange={onChange}
    />
  );
}

/**
 * T-112 — category/sub-category filtering above the rule picker, mirroring T-111 at the Super
 * Admin level. Purely a client-side narrowing of `options` (already fetched whole for the
 * campaign, T-037): no new query, no change to which rules `options` contains in the first place.
 *
 * Filter state is local to one `AddRule` instance, so each component in the journey keeps its own
 * independent filter — a Maker picking `COMPONENT` rules for step 1 and `AGGREGATE` rules for step
 * 2 never has one selection leak into the other (TC-4).
 */
function AddRule({
  options,
  disabled,
  onAdd,
}: {
  readonly options: readonly RuleOption[];
  readonly disabled?: boolean;
  readonly onAdd: (ruleId: number) => void;
}) {
  const [categoryFilter, setCategoryFilter] = useState<string>(NO_FILTER);
  const [subCategoryFilter, setSubCategoryFilter] = useState<string>(NO_FILTER);
  const [ruleId, setRuleId] = useState<string | null>(null);

  const categoryOptions = useMemo(
    () => uniqueOptions(options, 'categoryId', 'categoryName'),
    [options],
  );
  const subCategoryOptions = useMemo(() => {
    const scoped =
      categoryFilter === NO_FILTER
        ? options
        : options.filter((option) => String(option.categoryId) === categoryFilter);
    return uniqueOptions(scoped, 'subCategoryId', 'subCategoryName');
  }, [options, categoryFilter]);

  const filteredOptions = useMemo(
    () =>
      options.filter(
        (option) =>
          (categoryFilter === NO_FILTER || String(option.categoryId) === categoryFilter) &&
          (subCategoryFilter === NO_FILTER || String(option.subCategoryId) === subCategoryFilter),
      ),
    [options, categoryFilter, subCategoryFilter],
  );

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Select
          label="Category"
          className="flex-1"
          placeholder="All categories"
          value={categoryFilter === NO_FILTER ? null : categoryFilter}
          disabled={disabled}
          options={categoryOptions}
          onChange={(value) => {
            setCategoryFilter(value);
            setSubCategoryFilter(NO_FILTER);
            setRuleId(null);
          }}
        />
        <Select
          label="Sub-category"
          className="flex-1"
          placeholder="All sub-categories"
          value={subCategoryFilter === NO_FILTER ? null : subCategoryFilter}
          disabled={disabled || categoryFilter === NO_FILTER}
          options={subCategoryOptions}
          onChange={(value) => {
            setSubCategoryFilter(value);
            setRuleId(null);
          }}
        />
      </div>
      <div className="flex items-end gap-2">
        <Select
          label="Add a rule"
          className="flex-1"
          placeholder={
            filteredOptions.length === 0 ? 'No further rules available' : 'Select a rule…'
          }
          value={ruleId}
          disabled={disabled || filteredOptions.length === 0}
          options={filteredOptions.map((option) => ({
            value: String(option.ruleId),
            label: `${option.name} (${option.ruleCode})`,
          }))}
          onChange={setRuleId}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || ruleId === null}
          onClick={() => {
            if (ruleId === null) return;
            onAdd(Number(ruleId));
            setRuleId(null);
          }}
        >
          <Plus className="size-4" aria-hidden="true" />
          Add
        </Button>
      </div>
    </div>
  );
}

/** The distinct `(idKey, nameKey)` pairs of `options`, as `Select` options sorted by label — the
 * shared building block behind both the category and sub-category filters above. A `null` name
 * (the display-only half of the pair) falls back to a stable, still-unique label rather than
 * hiding the entry — no rule's category/sub-category id is ever missing (T-112's schema comment on
 * `ruleOptionSchema`), only its display name might legitimately be. */
function uniqueOptions(
  options: readonly RuleOption[],
  idKey: 'categoryId' | 'subCategoryId',
  nameKey: 'categoryName' | 'subCategoryName',
): { value: string; label: string }[] {
  const byId = new Map<number, string>();
  for (const option of options) {
    const id = option[idKey];
    if (!byId.has(id)) byId.set(id, option[nameKey] ?? `#${String(id)}`);
  }
  return [...byId.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, label]) => ({ value: String(id), label }));
}
