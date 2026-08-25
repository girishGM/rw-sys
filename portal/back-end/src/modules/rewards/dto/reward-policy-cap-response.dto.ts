/**
 * T-032 — the response body `/rewards/:id/policies/:policyId/caps` returns, built from
 * `RewardPolicyCapRow` (`reward-policy-caps.repository.ts`'s raw-query result), never a raw DB
 * row spread directly.
 */
import type { RewardPolicyCapRow } from '../reward-policy-caps.repository';
import type {
  RewardPolicyCapFrequencyUnitValue,
  RewardPolicyCapStatusValue,
  RewardPolicyCapTypeValue,
} from './reward-policy-cap.dto';

export interface RewardPolicyCapDto {
  readonly id: number;
  readonly rewardPolicyId: number;
  readonly capType: RewardPolicyCapTypeValue;
  readonly frequencyValue: number | null;
  readonly frequencyUnit: RewardPolicyCapFrequencyUnitValue | null;
  readonly maxOccurrences: number | null;
  readonly maxTotalAmount: number | null;
  readonly status: RewardPolicyCapStatusValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toRewardPolicyCapDto(row: RewardPolicyCapRow): RewardPolicyCapDto {
  return {
    id: row.id,
    rewardPolicyId: row.rewardPolicyId,
    capType: row.capType,
    frequencyValue: row.frequencyValue,
    frequencyUnit: row.frequencyUnit,
    maxOccurrences: row.maxOccurrences,
    maxTotalAmount: row.maxTotalAmount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
