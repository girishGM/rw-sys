/**
 * T-108 — the response bodies `/rule-resolvers` and `/rule-operators` return.
 *
 * Built by hand from the `RuleResolver`/`RuleOperator` model instances, never by spreading a
 * Sequelize row — same construction rule `rule-response.dto.ts` uses for `RuleCategoryDto`/
 * `RuleSubCategoryDto`. Deliberately omits `handlerClass` (a backend implementation detail with
 * no UI purpose) and the raw `inputSchema`/`applicableDataTypes` JSON text (nothing client-side
 * needs it yet — add it only when a real consumer does, per this task's own scope note).
 *
 * `resolverInputFieldKeys` (T-114) is the one exception to "backend-only stays off the wire":
 * it is exactly the data a parameter field's response-only `role`
 * (`packages/shared/src/rule.schema.ts#ruleFieldRoleSchema`) is computed from, so the rule
 * editor can explain *why* a field is `resolver_input`.
 */
import type { RuleResolver } from '@/database/models/rule-resolver.model';
import type { RuleOperator } from '@/database/models/rule-operator.model';

export interface RuleResolverDto {
  readonly id: number;
  readonly resolverCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly resolverInputFieldKeys: readonly string[];
}

export function toRuleResolverDto(resolver: RuleResolver): RuleResolverDto {
  return {
    id: resolver.id,
    resolverCode: resolver.resolverCode,
    name: resolver.name,
    description: resolver.description,
    status: resolver.status,
    resolverInputFieldKeys: resolver.resolverInputFieldKeys,
  };
}

export interface RuleOperatorDto {
  readonly id: number;
  readonly operatorCode: string;
  readonly displayName: string;
  readonly expectedValueType: string;
  readonly status: string;
}

export function toRuleOperatorDto(operator: RuleOperator): RuleOperatorDto {
  return {
    id: operator.id,
    operatorCode: operator.operatorCode,
    displayName: operator.displayName,
    expectedValueType: operator.expectedValueType,
    status: operator.status,
  };
}
