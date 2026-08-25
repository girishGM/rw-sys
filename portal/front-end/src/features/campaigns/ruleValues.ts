/**
 * T-037 — the client-side half of rule-value validation, kept out of `DynamicParameterForm.tsx`.
 *
 * Two reasons, and only the second is about lint. A module that exports both a component and
 * plain functions breaks React Fast Refresh (`react-refresh/only-export-components`), which the
 * workspace treats as an error at `--max-warnings=0`. More usefully, this function is the piece
 * a **caller** wants — the step-4 screen asks "is this rule complete?" without rendering
 * anything — so it belongs beside the component rather than inside it.
 *
 * What it is *not* is a control. `bindings.service.ts` re-validates the same values against the
 * same shared schema server-side (implementation note 9, TC-17); this exists so a maker sees the
 * problem next to the field.
 */
import { buildRuleValueSchema, type RuleParameters } from '@reward-portal/shared';

/**
 * The per-field messages `buildRuleValueSchema` produces for `values`, keyed by parameter key.
 *
 * `unrecognized_keys` needs its own branch: Zod reports an extra key on the **object**, with an
 * empty `path`, so a naive `issue.path[0]` mapping silently drops it and the maker sees nothing
 * at all while the server refuses the save (TC-19). The offending keys are on the issue itself,
 * and are surfaced under their own names — which is also the only way to say something useful
 * about a value that has no control to attach it to.
 */
export function validateValues(
  parameters: RuleParameters,
  values: Record<string, unknown>,
): Record<string, string> {
  const result = buildRuleValueSchema(parameters).safeParse(values);
  if (result.success) return {};

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        errors[key] ??= 'This rule does not accept a value with this name.';
      }
      continue;
    }
    const key = issue.path[0];
    if (typeof key === 'string' && errors[key] === undefined) errors[key] = issue.message;
  }
  return errors;
}
