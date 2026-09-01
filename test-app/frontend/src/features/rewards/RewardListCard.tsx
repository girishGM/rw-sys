/**
 * T-009 — one reward in the My Rewards list (`ARCHITECTURE.md` §4: "each tagged used/unused,
 * expiry countdown badge on anything unused and close to expiring"): icon, name/value, the
 * campaign it came from, a used/unused pill, and (only when it genuinely qualifies) the expiry
 * countdown badge.
 */
import type { ComponentType } from 'react';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { CreditCardIcon, TagIcon, ZapIcon, type IconProps } from '../../components/icons';
import type { RewardLedgerEntry, RewardType } from '../../types';
import { rewardValueLabel } from './rewardCopy';
import { expiryCountdownLabel } from './expiryLabel';

const ICON_BY_TYPE: Readonly<Record<RewardType, ComponentType<IconProps>>> = {
  cashback: CreditCardIcon,
  promo_code: TagIcon,
  points: ZapIcon,
};

export interface RewardListCardProps {
  reward: RewardLedgerEntry;
  /** The real campaign name (`GET /api/campaigns`'s `name`), resolved by the caller from
   * `reward.campaignCode` — falls back to the raw code if that campaign somehow isn't in the
   * caller's lookup, rather than showing nothing. */
  campaignName: string;
  /** Whether this exact reward id is in `dashboardSummary.expiringSoon` — the single source T-007's
   * own banner/stat card already read, so this card's badge can never disagree with it (this
   * task's implementation notes). */
  isExpiringSoon: boolean;
}

export function RewardListCard({ reward, campaignName, isExpiringSoon }: RewardListCardProps) {
  const Icon = ICON_BY_TYPE[reward.type];
  const unused = reward.status === 'unused';
  // TC-5: a used reward never shows an expiry badge, even defensively — redemption already made
  // expiry moot, regardless of what the (server-computed, unused-only) expiringSoon set contains.
  const expiryBadgeText =
    unused && isExpiringSoon && reward.expiresAt !== null
      ? expiryCountdownLabel(reward.expiresAt)
      : null;

  return (
    <Card className="flex items-center gap-4 p-4 sm:p-5">
      <span
        aria-hidden="true"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-chip bg-gradient-to-br from-accent to-secondary text-white"
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-heading text-base font-bold text-ink">
          {rewardValueLabel(reward)}
        </span>
        <span className="truncate font-body text-xs text-ink-muted">{campaignName}</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Badge tone={unused ? 'accent' : 'muted'}>{unused ? 'Unused' : 'Used'}</Badge>
        {expiryBadgeText !== null && <Badge tone="warn">{expiryBadgeText}</Badge>}
      </div>
    </Card>
  );
}
