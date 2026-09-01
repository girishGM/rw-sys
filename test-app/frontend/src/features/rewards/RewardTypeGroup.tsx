/**
 * T-009 — one type-section of the My Rewards list: a heading (type + count) plus either the
 * cards themselves or a sensible per-type empty state ("No promo codes yet") when this customer
 * genuinely has none of this type (TC-3) — never a broken/blank render.
 */
import { Card } from '../../components/Card';
import type { RewardLedgerEntry, RewardType } from '../../types';
import { rewardTypeLabel, rewardTypeNounPlural } from './rewardCopy';
import { RewardListCard } from './RewardListCard';

export interface RewardTypeGroupProps {
  type: RewardType;
  rewards: readonly RewardLedgerEntry[];
  /** `RewardLedgerEntry.campaignCode` → real campaign name (`GET /api/campaigns`), so each card
   * can show "the campaign it came from" (this task's Scope) rather than a raw code. */
  campaignNameByCode: ReadonlyMap<string, string>;
  /** Reward ids present in `dashboardSummary.expiringSoon` — see `RewardListCard`'s own prop doc
   * for why this is passed down rather than recomputed per card. */
  expiringSoonIds: ReadonlySet<string>;
}

export function RewardTypeGroup({
  type,
  rewards,
  campaignNameByCode,
  expiringSoonIds,
}: RewardTypeGroupProps) {
  const headingId = `reward-group-${type}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-heading text-base font-bold text-ink">
        {rewardTypeLabel(type)}{' '}
        <span className="font-body text-sm font-normal text-ink-muted">({rewards.length})</span>
      </h2>

      {rewards.length === 0 ? (
        <Card className="p-5">
          <p className="font-body text-sm text-ink-muted">No {rewardTypeNounPlural(type)} yet.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {rewards.map((reward) => (
            <li key={reward.id}>
              <RewardListCard
                reward={reward}
                campaignName={campaignNameByCode.get(reward.campaignCode) ?? reward.campaignCode}
                isExpiringSoon={expiringSoonIds.has(reward.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
