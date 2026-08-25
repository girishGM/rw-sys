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
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Journey, RuleOption } from '@reward-portal/shared';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card, CardBody, CardHeader } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { Select } from '../../../components/Select';
import { DynamicParameterForm } from '../DynamicParameterForm';

export interface ComponentRulesStepProps {
  readonly journey: Journey | undefined;
  readonly ruleOptions: readonly RuleOption[];
  readonly disabled?: boolean;
  readonly onBindRule: (componentId: number, ruleId: number) => void;
  readonly onUnbindRule: (bindingId: number) => void;
  readonly onSaveValues: (bindingId: number, values: Record<string, unknown>) => void;
  /** Server-side field errors, keyed `${bindingId}.${parameterKey}` — TC-17's 400 rendered on
   * the field that caused it rather than as a toast with no context. */
  readonly serverErrors?: Readonly<Record<string, string>>;
}

export function ComponentRulesStep({
  journey,
  ruleOptions,
  disabled,
  onBindRule,
  onUnbindRule,
  onSaveValues,
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
                <header className="mb-3 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium text-slate-800">
                    {component.sequenceOrder}. {component.name}
                  </h4>
                  {component.rules.length === 0 && <Badge tone="warning">no rule</Badge>}
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
                      disabled={disabled}
                      serverErrors={pickErrors(serverErrors, rule.id)}
                      onSave={(values) => {
                        onSaveValues(rule.id, values);
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

interface RuleValuesProps {
  readonly bindingId: number;
  readonly title: string;
  readonly versionNo: number | null;
  readonly parameters: Parameters<typeof DynamicParameterForm>[0]['parameters'];
  readonly values: Record<string, unknown>;
  readonly disabled?: boolean;
  readonly serverErrors: Record<string, string>;
  readonly onSave: (values: Record<string, unknown>) => void;
  readonly onRemove: () => void;
}

function RuleValues({
  bindingId,
  title,
  versionNo,
  parameters,
  values,
  disabled,
  serverErrors,
  onSave,
  onRemove,
}: RuleValuesProps) {
  const [draft, setDraft] = useState<Record<string, unknown>>(values);
  const dirty = JSON.stringify(draft) !== JSON.stringify(values);

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

      <DynamicParameterForm
        parameters={parameters}
        values={draft}
        disabled={disabled}
        serverErrors={serverErrors}
        idPrefix={`rule-${String(bindingId)}`}
        onChange={setDraft}
      />

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

function AddRule({
  options,
  disabled,
  onAdd,
}: {
  readonly options: readonly RuleOption[];
  readonly disabled?: boolean;
  readonly onAdd: (ruleId: number) => void;
}) {
  const [ruleId, setRuleId] = useState<string | null>(null);

  return (
    <div className="flex items-end gap-2">
      <Select
        label="Add a rule"
        className="flex-1"
        placeholder={options.length === 0 ? 'No further rules available' : 'Select a rule…'}
        value={ruleId}
        disabled={disabled || options.length === 0}
        options={options.map((option) => ({
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
  );
}
