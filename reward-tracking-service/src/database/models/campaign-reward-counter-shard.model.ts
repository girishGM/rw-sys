import type { RewardKind } from './reward-fact.model';

/**
 * `reward_tracking.campaign_reward_counter_shard` — `brain-storm/02-DATA-MODEL.md` §4. See
 * `inbound-event-log.model.ts`'s header for this directory's own convention.
 *
 * No surrogate `id` — the primary key is the full composite business key including `shard_key`
 * (R7). `distinct_customer_hll` is typed `Buffer | null` — an optional HyperLogLog sketch, opaque
 * to every consumer except whatever eventually decodes it (not this task's concern).
 */
export interface CampaignRewardCounterShardRow {
  tenant_id: number;
  campaign_code: string;
  reward_category: string;
  reward_kind: RewardKind | null;
  unit_type: string | null;
  unit_code: string | null;
  shard_key: number;
  total_reward_value: string;
  total_reward_count: number;
  distinct_customer_hll: Buffer | null;
  updated_at: Date;
}
