/**
 * T-041 — pure diff/suggestion helpers shared by `RuleVersionsService` and
 * `RewardVersionsService` (implementation notes 8/9). No model, no I/O — unit-testable in
 * isolation, and reused by `BlastsService`'s preview (`isBreaking` display) without either
 * service depending on the other.
 */

export interface FieldDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly typeChanged: readonly string[];
}

interface RuleParameterFieldLike {
  readonly key?: unknown;
  readonly type?: unknown;
}

/** Reads `parameters.fields` tolerantly — a malformed or absent shape diffs as "no fields",
 * mirroring `rule-master.model.ts`'s own "never throws on bad JSON" discipline. */
function fieldMap(parameters: Record<string, unknown> | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const fields = (parameters as { fields?: unknown } | null | undefined)?.fields;
  if (!Array.isArray(fields)) return map;
  for (const field of fields as readonly RuleParameterFieldLike[]) {
    if (typeof field?.key === 'string' && typeof field.type === 'string') {
      map.set(field.key, field.type);
    }
  }
  return map;
}

/**
 * Diffs a rule's `parameters` meta-schema (`{ fields: [{ key, type, ... }] }`) between two
 * versions — implementation note 8: "highlighting parameter additions/removals/type changes".
 */
export function diffRuleParameterFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): FieldDiff {
  const beforeMap = fieldMap(before);
  const afterMap = fieldMap(after);

  const added = [...afterMap.keys()].filter((key) => !beforeMap.has(key)).sort();
  const removed = [...beforeMap.keys()].filter((key) => !afterMap.has(key)).sort();
  const typeChanged = [...beforeMap.keys()]
    .filter((key) => afterMap.has(key) && afterMap.get(key) !== beforeMap.get(key))
    .sort();

  return { added, removed, typeChanged };
}

/**
 * Diffs a flat object's top-level keys/JS types — the reward-side stand-in for
 * `diffRuleParameterFields` (`version.schema.ts`'s own comment: `connector_config`'s top-level
 * keys play the role `rule_versions.parameters.fields` plays for rules; not spelled out
 * verbatim in 06-VERSIONING.md's "Reward equivalents mirror these exactly", so this is this
 * task's own documented mapping).
 */
export function diffFlatObjectKeys(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): FieldDiff {
  const beforeObj = before ?? {};
  const afterObj = after ?? {};
  const beforeKeys = new Set(Object.keys(beforeObj));
  const afterKeys = new Set(Object.keys(afterObj));

  const added = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort();
  const removed = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort();
  const typeChanged = [...beforeKeys]
    .filter((key) => afterKeys.has(key) && typeof beforeObj[key] !== typeof afterObj[key])
    .sort();

  return { added, removed, typeChanged };
}

/**
 * The system's own suggestion (implementation note 9): a removed parameter, or one whose type
 * changed, cannot auto-migrate a campaign already bound to the previous version — exactly the
 * condition TC-26 names ("auto-detection on a removed parameter → Suggested `true`"). A purely
 * additive change is not suggested as breaking: an existing binding simply never supplies the
 * new field.
 */
export function suggestIsBreaking(diff: FieldDiff): boolean {
  return diff.removed.length > 0 || diff.typeChanged.length > 0;
}
