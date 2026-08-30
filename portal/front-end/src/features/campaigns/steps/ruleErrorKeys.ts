/**
 * T-148 — the key scheme `ComponentRulesStep`'s `serverErrors` map uses, written once so the
 * producer (`CampaignWizardPage`, which turns an `ApiError`'s `details` into it) and the consumer
 * (`ComponentRulesStep`, which splits it back apart) cannot drift.
 *
 * T-136 established the shape: `${bindingId}.${parameterKey}`, flat, one record for the whole
 * step. T-148 adds two more members to that namespace rather than a second parallel map — a
 * binding's operator, and a rejection that belongs to a whole component rather than to any one
 * binding.
 *
 * Its own module rather than another export from `ComponentRulesStep.tsx` because that file
 * exports React components: mixing a plain function in breaks Fast Refresh's
 * one-file-one-concern assumption (`react-refresh/only-export-components`), which this project
 * lints as an error at `--max-warnings=0`.
 */

/**
 * The parameter-key half of an operator rejection. `OperatorNotAllowedError`'s own `details[]`
 * entry names the bare field `operator` (`campaigns.errors.ts`), and `pickErrors` hands a rule's
 * controls exactly this half after stripping the binding-id prefix — so the two ends meet on this
 * one constant.
 */
export const OPERATOR_ERROR_FIELD = 'operator';

/** Where a rejected operator lands: the same `${bindingId}.${field}` shape as a parameter value. */
export function operatorErrorKey(bindingId: number): string {
  return `${String(bindingId)}.${OPERATOR_ERROR_FIELD}`;
}

/**
 * Where a rejected "rules combine" change lands. Prefixed with `component-` so it can share the
 * one flat record with the binding-keyed entries above: a binding id is always a bare number, so
 * `component-7.ruleLogic` can never be read as one.
 */
export function componentErrorKey(componentId: number): string {
  return `component-${String(componentId)}.ruleLogic`;
}
