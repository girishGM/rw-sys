/**
 * T-033 — plain-function validators for `dto/*.ts`'s `class-validator` adapters, the same split
 * `rules.validators.ts`/`rule-validators.decorators.ts` establish.
 */
import { ENTITY_ACTION_CATALOGUE } from './access-control.constants';

/**
 * `true` when `value` is a `{ entity: action[] }` map every cell of which is a real
 * `{entity, action}` pair from {@link ENTITY_ACTION_CATALOGUE} (TC-23: "Invalid entity or action
 * name in a PUT → 400 against the entity catalogue"). An empty object is valid — TC-24: "PUT with
 * an empty permission array for a role → Accepted".
 */
export function isPermissionsMatrix(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  for (const [entity, actions] of Object.entries(value as Record<string, unknown>)) {
    const allowedActions = ENTITY_ACTION_CATALOGUE[entity];
    if (allowedActions === undefined) return false;
    if (!Array.isArray(actions)) return false;
    for (const action of actions) {
      if (typeof action !== 'string' || !allowedActions.includes(action)) return false;
    }
  }

  return true;
}

/** `true` for a plain, JSON-serialisable object — `role_dashboard_widgets.widget_config`'s shape
 * (mirrors `toWidgetConfig` in `bootstrap.service.ts`, which normalises the same column on read). */
export function isWidgetConfig(value: unknown): boolean {
  return (
    value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value))
  );
}
