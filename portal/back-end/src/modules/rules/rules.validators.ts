/**
 * T-031 — plain, framework-free validators, kept separate from `dto/rule-parameter.decorator.ts`
 * so they stay directly unit-testable without a `class-validator` fixture object — the same
 * split `countries.validators.ts` documents for its own three functions.
 */
import { ruleParametersSchema } from '@reward-portal/shared';
import { RULE_CODE_PATTERN } from './rules.constants';

/** `rule_code` — upper-snake-case business key (implementation note, `rules.constants.ts`). */
export function isRuleCode(value: unknown): boolean {
  return typeof value === 'string' && RULE_CODE_PATTERN.test(value);
}

/**
 * Whether `value` is a well-formed `rule_master.parameters` meta-schema — implementation note
 * 4: *"Validate it against a meta-schema on save — a malformed `parameters` blob would break
 * the maker's wizard at campaign time, far from the cause."* Delegates to the one definition
 * this project keeps of that meta-schema, `packages/shared/src/rule.schema.ts`'s
 * `ruleParametersSchema`, so the server-side gate and the front-end parameter-schema builder
 * can never silently drift apart (00-ARCHITECTURE.md §8).
 */
export function isRuleParameters(value: unknown): boolean {
  return ruleParametersSchema.safeParse(value).success;
}
