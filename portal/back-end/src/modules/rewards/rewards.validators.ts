/**
 * T-032 — plain, framework-free validators, kept separate from `dto/reward-validators.decorators.ts`
 * so they stay directly unit-testable without a `class-validator` fixture object — the same split
 * `rules.validators.ts` documents for its own functions.
 */
import { rewardConnectorConfigSchema } from '@reward-portal/shared';
import { REWARD_POLICY_CODE_PATTERN, REWARD_SYSTEM_CODE_PATTERN } from './rewards.constants';

/** `systemCode` — upper-snake-case business key (implementation note, `rewards.constants.ts`). */
export function isRewardSystemCode(value: unknown): boolean {
  return typeof value === 'string' && REWARD_SYSTEM_CODE_PATTERN.test(value);
}

/** `policyCode` — upper-snake-case business key, same shape as `isRewardSystemCode`. */
export function isRewardPolicyCode(value: unknown): boolean {
  return typeof value === 'string' && REWARD_POLICY_CODE_PATTERN.test(value);
}

/**
 * Whether `value` is a well-formed `connectorConfig` submission — delegates to the one
 * definition this project keeps of that bound, `packages/shared/src/reward.schema.ts`'s
 * `rewardConnectorConfigSchema`, so the server-side gate and the SPA's own client-side check can
 * never silently drift apart (00-ARCHITECTURE.md §8). `undefined` is valid here (an omitted
 * `connectorConfig` leaves it unchanged/unset) — `@IsOptional()` on the DTO field is what makes
 * that case never reach this function at all; it is handled here too only so the function is
 * total.
 */
export function isRewardConnectorConfig(value: unknown): boolean {
  if (value === undefined) return true;
  return rewardConnectorConfigSchema.safeParse(value).success;
}
