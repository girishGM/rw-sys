/**
 * T-009 — groups a customer's full reward ledger (`GET /api/rewards`, unfiltered/unsorted per
 * `tracking-service`'s own `routes/rewards.ts` doc comment: "the frontend groups by type/status
 * itself") into the 3 fixed `RewardType` buckets `ARCHITECTURE.md` §4 names. Every bucket is
 * always present (possibly empty) rather than only the types a customer happens to have, so a
 * caller never has to guard a missing key — "don't assume every customer always has all 3 types"
 * (this task's Scope) cuts both ways: a type this customer has zero of is a real, empty group,
 * not an absent one.
 */
import { REWARD_TYPES, type RewardLedgerEntry, type RewardType } from '../../types';

export type RewardsByType = Readonly<Record<RewardType, readonly RewardLedgerEntry[]>>;

export function groupRewardsByType(rewards: readonly RewardLedgerEntry[]): RewardsByType {
  const grouped = Object.fromEntries(
    REWARD_TYPES.map((type) => [type, [] as RewardLedgerEntry[]]),
  ) as Record<RewardType, RewardLedgerEntry[]>;

  for (const reward of rewards) {
    grouped[reward.type].push(reward);
  }

  return grouped;
}
