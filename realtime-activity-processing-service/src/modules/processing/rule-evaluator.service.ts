/**
 * T-RAP-031. The rule evaluator — a pure function of the claimed `activity_logs` row plus the
 * cached `RuleRef`s already resolved by the caller (`05-PROCESSING-PIPELINE.md` §5): no DB access,
 * no cache access of its own. This matters because the same row may need re-evaluation after a
 * crash-and-retry (TC-6), and the result must be identical both times.
 *
 * **Expression language — this task's own discretion (`BACKLOG.md` B-5).** Read against the real
 * shape the portal actually produces (`rule_master.expression`/`tracker_component_rules` — see
 * `project-plan/requirements/rule-engine-mapped-design.md` §1: "`expression` is inert text — never
 * evaluated by the portal [today]", i.e. this service is genuinely the first place it's ever
 * interpreted) and this service's own seeded demo data
 * (`src/database/seeds/seed-data.constants.ts`), every real example is a single, simple
 * comparison: `activity.<field> <op> <literal>`, e.g. `activity.activity_value >= 1` or
 * `activity.activity_type == "SIGNUP"`. This evaluator implements exactly that grammar —
 * `<field>` a dotted path rooted at `activity.` and resolved against the claimed row's own
 * (already snake_case) columns, `<op>` one of `== != >= <= > <`, `<literal>` a quoted string or a
 * number — optionally combined with `&&` (logical AND) for a single rule's own multi-condition
 * expression. A rule that references an unsupported field/operator/literal, or a malformed
 * expression, is a genuine configuration defect, not a normal "didn't pass" outcome — `evaluate()`
 * throws for that case (propagating out of the caller's transaction, per that file's own header),
 * never silently treats it as pass or fail.
 *
 * **Rule combination**: `05-PROCESSING-PIPELINE.md` §5's own wording is "if every rule bound to
 * this component passes" — every *active* `RuleRef` bound to the component must pass (an
 * `Array.prototype.every` over an empty list is vacuously `true`: a component with no bound rules
 * at all always "passes", there being nothing to fail).
 *
 * **T-RAP-063 update (Phase 1 of the rule-expression binding fix — see
 * `realtime-activity-processing-service-plan/brain-storm/T-RAP-063-rule-expression-binding-diagnosis.md`
 * for the full evidence base).** The grammar above was validated only against this service's own
 * seed fixtures, never against a real portal-authored `rule_master.expression` — which is a
 * **template** carrying literal, unbound `:placeholder` tokens (`:value`, `:currency`,
 * `:windowType`, ...) resolved at bind time from `rule.boundValuesJson`, not a ready-to-parse
 * `field op literal` triple. Two changes, both scoped to this task:
 *  1. **A binding/substitution step now runs before `CONDITION_PATTERN` ever sees a clause** —
 *     any `:placeholder` token present as a simple (string/number) key in `rule.boundValuesJson`
 *     is substituted with its real value first (`resolveClauseCondition`, module-scope, pure).
 *  2. **A clause this service cannot fully resolve today no longer throws and rolls back the
 *     whole claimed transaction.** Whether the gap is a placeholder with nothing on the wire to
 *     resolve it (e.g. `:operator` — not in `boundValuesJson`, and not even settable through the
 *     portal's own API for an unversioned binding, diagnosis doc §5), or a placeholder that *does*
 *     resolve to a literal value but the fully-substituted clause still doesn't fit the supported
 *     `activity.<field> <op> <literal>` grammar (e.g. `:windowType`'s natural-language "within the
 *     ... window" phrasing — real resolver dispatch, `T-RAP-064`, not a regex extension here) —
 *     both are classified as "unresolved", not "malformed": `evaluate()` logs a warning naming the
 *     rule and the unresolved placeholder(s), evaluates that one rule as **not passed**, and never
 *     throws. A clause with **zero** `:placeholder` tokens that still fails to parse is unchanged
 *     — that is a genuine configuration defect (a real bug, not a template gap) and still throws,
 *     exactly as before this task.
 *  This is a deliberate behavioral choice (diagnosis doc §8, open question 1): a misconfigured/
 *  not-yet-wireable rule now silently evaluates false rather than raising a batch-poisoning error,
 *  because one bad rule anywhere in a tenant's campaign graph must never stall every activity
 *  behind it in the claim queue. This task's own scope stops at "never throws, correctly binds
 *  whatever's on the wire today" — it does **not** make `RULE_ACTIVITY_VALUE_001`/
 *  `RULE_ACTIVITY_WINDOW_001` evaluate to the business-correct answer (that needs the wire-contract
 *  extension `T-175` plus the resolver-dispatch mechanism `T-RAP-064`).
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import type { BoundRuleProto } from '@/modules/campaign-cache/campaign-config.client';

/** A component with no numeric override in any of its bound rules' `boundValuesJson` completes on
 * its first passing activity — matches every example in this service's own seed data, and the
 * only semantics `tracker_components.completion_criteria` (the field `01-DATABASE.md` §4's own
 * comment names as the intended source) could ever have carried: real inspection of the portal's
 * live schema/gRPC contract (`03-GRPC-CONTRACT.md` §2, `TrackerComponent`) confirms that column is
 * (a) not exposed over gRPC to this service at all, and (b) "confirmed unused" upstream
 * (`portal/back-end/src/database/migrations/T104_001_tracker_component_rule_bindings.ts`'s own
 * header) — see this task's own completion report "Deviations from spec" for the full finding.
 * `resolveRequiredCount` below is this task's own documented fallback: default `1`, overridable by
 * a `requiredCount`/`required_count` numeric key in any active bound rule's `boundValuesJson`, the
 * only per-component dynamic-value channel that actually exists on the wire today. */
export const DEFAULT_REQUIRED_COUNT = 1;

const REQUIRED_COUNT_KEYS = ['requiredCount', 'required_count'] as const;

export interface RuleEvaluationOutcome {
  passed: boolean;
  /** The specific rule that failed — `null` when `passed` is `true`. Feeds
   * `activity_logs.comment` (`05-PROCESSING-PIPELINE.md` §5 point 3). */
  failedRuleCode: string | null;
  /** Human-readable explanation, always present, for `activity_logs.comment` regardless of
   * outcome. */
  comment: string;
}

type ComparisonOperator = '==' | '!=' | '>=' | '<=' | '>' | '<';

interface ParsedCondition {
  field: string;
  operator: ComparisonOperator;
  literal: string | number;
}

// Longest operators first so `>=`/`<=` aren't mis-tokenized as `>`/`<` followed by a stray `=`.
const CONDITION_PATTERN = /^activity\.([a-zA-Z0-9_]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;

function parseLiteral(raw: string): string | number {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  const numeric = Number(trimmed);
  if (trimmed.length > 0 && !Number.isNaN(numeric)) {
    return numeric;
  }
  throw new Error(`Unsupported rule expression literal: ${JSON.stringify(raw)}`);
}

function parseCondition(clause: string): ParsedCondition {
  const trimmed = clause.trim();
  const match = CONDITION_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`Unsupported rule expression clause: ${JSON.stringify(clause)}`);
  }
  const [, field, operator, rawLiteral] = match;
  return { field, operator: operator as ComparisonOperator, literal: parseLiteral(rawLiteral) };
}

// T-RAP-063: matches a `:placeholder` template token — `:` followed by an identifier, the same
// shape every real portal-authored `rule_master.expression` template uses (`:value`, `:currency`,
// `:operator`, `:windowType`, ...). A fresh `RegExp` per call (never a shared module-scope `g`
// instance) so callers can safely use `matchAll`/`replace` without any shared `lastIndex` state.
function placeholderPattern(): RegExp {
  return /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
}

/**
 * The raw `:placeholder` tokens present in a clause, ignoring anything inside a quoted string
 * literal (so a real literal like `"SIGNUP:BONUS"` is never mistaken for a template token) —
 * order-preserving, de-duplicated.
 */
function extractPlaceholders(clause: string): string[] {
  const withoutQuotedLiterals = clause.replace(/"[^"]*"|'[^']*'/g, '');
  const seen = new Set<string>();
  for (const match of withoutQuotedLiterals.matchAll(placeholderPattern())) {
    seen.add(match[1]);
  }
  return Array.from(seen);
}

/** A `boundValuesJson` value this service knows how to splice into an expression as a literal —
 * `undefined` for anything else (object, array, `null`, `undefined`), which callers treat exactly
 * like "no value present" (the value exists on the wire but this service cannot safely stringify
 * it into the comparison grammar, so it's just as unresolved as a missing key). */
function formatBoundValueAsLiteral(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return undefined;
}

type ClauseResolution =
  | { kind: 'condition'; condition: ParsedCondition }
  | { kind: 'unresolved'; placeholders: string[] };

/**
 * T-RAP-063. Pure — no row access, no logging — so it's independently testable from the
 * row/rule-code-aware warning logic `evaluate()` layers on top. Substitutes every `:placeholder`
 * token found in `clause` from `boundValues` where a simple (string/number) value is present, then
 * attempts to parse the result as a normal `activity.<field> <op> <literal>` condition.
 *
 * A clause with **no** placeholder tokens at all is parsed exactly as before this task — a parse
 * failure there is a genuine configuration defect, not a template gap, and `parseCondition`'s own
 * throw is left to propagate.
 *
 * A clause **with** placeholder tokens never throws from this function: any token missing from
 * `boundValues` (or present with a value this service can't format as a literal) is reported back
 * as `unresolved`; and even when every token *did* resolve, a `parseCondition` failure on the
 * fully-substituted text (e.g. `:windowType`'s natural-language clause shape — real resolver
 * dispatch, not a regex extension, is `T-RAP-064`'s job) is *also* reported as `unresolved` rather
 * than allowed to throw — both are "a clause this service cannot resolve today", not "a genuinely
 * malformed expression".
 */
function resolveClauseCondition(
  clause: string,
  boundValues: Readonly<Record<string, unknown>>,
): ClauseResolution {
  const rawPlaceholders = extractPlaceholders(clause);
  if (rawPlaceholders.length === 0) {
    return { kind: 'condition', condition: parseCondition(clause) };
  }

  const missing: string[] = [];
  let substituted = clause;
  for (const placeholder of rawPlaceholders) {
    const hasValue = Object.prototype.hasOwnProperty.call(boundValues, placeholder);
    const literal = hasValue ? formatBoundValueAsLiteral(boundValues[placeholder]) : undefined;
    if (literal === undefined) {
      missing.push(placeholder);
      continue;
    }
    substituted = substituted.replace(new RegExp(`:${placeholder}\\b`, 'g'), literal);
  }
  if (missing.length > 0) {
    return { kind: 'unresolved', placeholders: missing };
  }

  try {
    return { kind: 'condition', condition: parseCondition(substituted) };
  } catch {
    return { kind: 'unresolved', placeholders: rawPlaceholders };
  }
}

function splitExpressionClauses(expression: string): string[] {
  const clauses = expression
    .split('&&')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) {
    throw new Error('Empty rule expression');
  }
  return clauses;
}

function resolveActivityField(row: ActivityLogRow, field: string): unknown {
  const record = row as unknown as Record<string, unknown>;
  if (!(field in record)) {
    throw new Error(
      `Unsupported rule expression field: "activity.${field}" is not a known activity_logs column`,
    );
  }
  return record[field];
}

function compare(actual: unknown, condition: ParsedCondition): boolean {
  if (typeof condition.literal === 'number') {
    const actualNumber = Number(actual as string | number);
    if (Number.isNaN(actualNumber)) {
      return false;
    }
    switch (condition.operator) {
      case '==':
        return actualNumber === condition.literal;
      case '!=':
        return actualNumber !== condition.literal;
      case '>=':
        return actualNumber >= condition.literal;
      case '<=':
        return actualNumber <= condition.literal;
      case '>':
        return actualNumber > condition.literal;
      case '<':
        return actualNumber < condition.literal;
    }
  }
  const actualString = actual === null || actual === undefined ? '' : String(actual);
  switch (condition.operator) {
    case '==':
      return actualString === condition.literal;
    case '!=':
      return actualString !== condition.literal;
    default:
      throw new Error(
        `Unsupported rule expression operator "${condition.operator}" for a string literal — ` +
          'only == and != compare strings.',
      );
  }
}

@Injectable()
export class RuleEvaluatorService {
  private readonly logger = new Logger(RuleEvaluatorService.name);

  /**
   * Evaluates every *active* `RuleRef` bound to the claimed row's own tracker component. Pure
   * except for `this.logger.warn` on the T-RAP-063 "unresolved placeholder" path below (no other
   * side effect, no DB/cache access): throws (never returns) only for a malformed/unsupported
   * expression that carries **no** `:placeholder` template token — a genuine configuration defect
   * (`05-PROCESSING-PIPELINE.md` §5 point 3's own "reserve 'error' for genuine failures ... not for
   * 'the activity didn't satisfy the rule'" — a rule that cannot even be parsed is the former, not
   * the latter) — or for an unknown `activity.<field>` reference, same as before this task.
   *
   * T-RAP-063: a clause that *does* carry a `:placeholder` token this service cannot resolve today
   * (missing from `boundValuesJson`, or resolvable to a literal but still not a supported
   * `activity.<field> <op> <literal>` shape once substituted) no longer throws — see this file's
   * own header. That rule is evaluated as **not passed**, with a warning naming the exact
   * unresolved placeholder(s) and the rule code, and every other rule bound to this same component
   * (and every other row in the claimed queue) proceeds completely unaffected.
   */
  evaluate(row: ActivityLogRow, ruleRefs: readonly BoundRuleProto[]): RuleEvaluationOutcome {
    const activeRules = ruleRefs.filter((rule) => rule.status === 'active');
    for (const rule of activeRules) {
      const boundValues = this.parseBoundValuesJson(rule);
      const clauses = splitExpressionClauses(rule.expression);
      let unresolvedPlaceholders: string[] | null = null;
      let clausesPassed = true;
      for (const clause of clauses) {
        const resolution = resolveClauseCondition(clause, boundValues);
        if (resolution.kind === 'unresolved') {
          unresolvedPlaceholders = resolution.placeholders;
          break;
        }
        if (!compare(resolveActivityField(row, resolution.condition.field), resolution.condition)) {
          clausesPassed = false;
          break;
        }
      }

      if (unresolvedPlaceholders !== null) {
        for (const placeholder of unresolvedPlaceholders) {
          this.logger.warn(
            `rule ${rule.ruleCode} on tracker_component ${row.tracker_component_code}: ` +
              `cannot resolve :${placeholder} (not present on this event's rule metadata) — ` +
              'evaluating as not-passed',
          );
        }
        return {
          passed: false,
          failedRuleCode: rule.ruleCode,
          comment:
            `Rule "${rule.ruleCode}" could not be evaluated: unresolved placeholder(s) ` +
            `${unresolvedPlaceholders.map((p) => `:${p}`).join(', ')} in expression ` +
            `"${rule.expression}" for activity_logs row ${row.id} — evaluated as not passed.`,
        };
      }
      if (!clausesPassed) {
        return {
          passed: false,
          failedRuleCode: rule.ruleCode,
          comment: `Rule "${rule.ruleCode}" did not pass: expression "${rule.expression}" evaluated false for activity_logs row ${row.id}.`,
        };
      }
    }
    return {
      passed: true,
      failedRuleCode: null,
      comment:
        activeRules.length === 0
          ? 'No active rules bound to this component; treated as passed.'
          : 'All bound rules passed.',
    };
  }

  /**
   * How many passing activities this component needs to complete — see this file's own header and
   * `DEFAULT_REQUIRED_COUNT`'s own comment for the full "why" (`completion_criteria` is
   * unavailable). Pure and side-effect free like `evaluate()`; a malformed `boundValuesJson` is
   * logged and ignored (this override is a convenience, not load-bearing config the way the
   * expression itself is), never thrown.
   */
  resolveRequiredCount(ruleRefs: readonly BoundRuleProto[]): number {
    let resolved = DEFAULT_REQUIRED_COUNT;
    for (const rule of ruleRefs) {
      if (rule.status !== 'active') {
        continue;
      }
      const override = this.extractRequiredCountOverride(rule);
      if (override !== undefined && override > resolved) {
        resolved = override;
      }
    }
    return resolved;
  }

  private extractRequiredCountOverride(rule: BoundRuleProto): number | undefined {
    const record = this.parseBoundValuesJson(rule);
    for (const key of REQUIRED_COUNT_KEYS) {
      const value = record[key];
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
      }
    }
    return undefined;
  }

  /**
   * `rule.boundValuesJson` parsed to a plain object, or `{}` when absent/malformed/not an object —
   * shared by `extractRequiredCountOverride` (pre-dates this task) and, as of T-RAP-063, by
   * `evaluate()`'s own `:placeholder` substitution step. A malformed value is logged once and
   * treated as "no bound values at all", never thrown — same discipline both callers already
   * relied on for `boundValuesJson`, which is a convenience channel, not load-bearing config the
   * way `expression` itself is.
   */
  private parseBoundValuesJson(rule: BoundRuleProto): Record<string, unknown> {
    if (!rule.boundValuesJson) {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rule.boundValuesJson);
    } catch {
      this.logger.warn(
        `Rule "${rule.ruleCode}" has malformed boundValuesJson (${JSON.stringify(rule.boundValuesJson)}) — ignored.`,
      );
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  }
}
