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
   * Evaluates every *active* `RuleRef` bound to the claimed row's own tracker component. Pure:
   * throws (never returns) for a malformed/unsupported expression or field, since that is a
   * genuine configuration defect (`05-PROCESSING-PIPELINE.md` §5 point 3's own "reserve 'error'
   * for genuine failures ... not for 'the activity didn't satisfy the rule'" — a rule that cannot
   * even be parsed is the former, not the latter).
   */
  evaluate(row: ActivityLogRow, ruleRefs: readonly BoundRuleProto[]): RuleEvaluationOutcome {
    const activeRules = ruleRefs.filter((rule) => rule.status === 'active');
    for (const rule of activeRules) {
      if (!this.evaluateExpression(row, rule.expression)) {
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
    if (!rule.boundValuesJson) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rule.boundValuesJson);
    } catch {
      this.logger.warn(
        `Rule "${rule.ruleCode}" has malformed boundValuesJson (${JSON.stringify(rule.boundValuesJson)}) — ignored for required-count resolution.`,
      );
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    for (const key of REQUIRED_COUNT_KEYS) {
      const value = record[key];
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
      }
    }
    return undefined;
  }

  private evaluateExpression(row: ActivityLogRow, expression: string): boolean {
    const clauses = expression
      .split('&&')
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);
    if (clauses.length === 0) {
      throw new Error(`Empty rule expression`);
    }
    return clauses.every((clause) => {
      const condition = parseCondition(clause);
      return compare(resolveActivityField(row, condition.field), condition);
    });
  }
}
