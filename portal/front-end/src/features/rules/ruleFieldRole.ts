/**
 * T-115 — the display label for a rule parameter field's `role` (T-114:
 * `packages/shared/src/rule.schema.ts#RuleFieldRole`). Shared by `ParameterFieldsEditor.tsx`
 * (client-side preview, computed from a previewed Resolver's `resolverInputFieldKeys`) and
 * `RuleDetailPage.tsx` (server-computed, displayed as-is from `GET /rules/:id`) so the two
 * surfaces can never drift on wording. Kept in its own module, not a component file, so
 * `react-refresh/only-export-components` stays clean.
 */
export function ruleFieldRoleLabel(role: 'resolver_input' | 'compare_value'): string {
  return role === 'resolver_input' ? 'Resolver input' : 'Compared value';
}
