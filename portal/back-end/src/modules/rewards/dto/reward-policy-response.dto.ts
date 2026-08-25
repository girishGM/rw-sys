/**
 * T-032 — the response body `/rewards/:id/policies` returns. `config` is plain JSON, returned
 * as-is (never secret, unlike `connectorConfig`).
 */
import type { RewardPolicy } from '@/database/models/reward-policy.model';

export interface RewardPolicyDto {
  readonly id: number;
  readonly rewardSystemId: number;
  readonly policyCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly config: Record<string, unknown>;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toRewardPolicyDto(policy: RewardPolicy): RewardPolicyDto {
  return {
    id: policy.id,
    rewardSystemId: policy.rewardSystemId,
    policyCode: policy.policyCode,
    name: policy.name,
    description: policy.description,
    config: policy.config,
    status: policy.status,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}
