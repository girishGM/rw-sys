/**
 * T-008 — the Reward card (this task's Scope: "the Reward card (type, value, earned/not-yet-
 * earned state derived from whether the tracker is actually complete for the selected customer)").
 * `earned` is passed in by the caller, computed from the tracker's own real completion state
 * (`GET /api/campaigns`'s `TrackerProgressSummary.completed` — the same server-evaluated flag
 * `TrackerRow` on the Dashboard reads), never hardcoded to one state (TC-4/TC-5).
 */
import { CreditCardIcon, GiftIcon, TagIcon, ZapIcon, type IconProps } from '../../components/icons';
import { Badge } from '../../components/Badge';
import type { ComponentType } from 'react';
import type { RewardAssignment } from '../../types';
import { rewardTypeLabel, rewardValueLabel } from './rewardCopy';

export interface RewardCardProps {
  reward: RewardAssignment | null;
  earned: boolean;
}

const ICON_BY_UNIT_TYPE: Readonly<Record<string, ComponentType<IconProps>>> = {
  currency: CreditCardIcon,
  voucher: TagIcon,
  points: ZapIcon,
};

export function RewardCard({ reward, earned }: RewardCardProps) {
  if (!reward) {
    return (
      <div className="flex items-center gap-3 rounded-chip bg-surface-2 p-4">
        <p className="font-body text-sm text-ink-muted">No reward is attached to this tracker.</p>
      </div>
    );
  }

  const Icon = ICON_BY_UNIT_TYPE[reward.unitType ?? ''] ?? GiftIcon;

  return (
    <div className="flex items-center gap-3 rounded-chip bg-surface-2 p-4">
      <span
        aria-hidden="true"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-chip bg-gradient-to-br from-accent to-secondary text-white"
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-body text-xs font-semibold uppercase tracking-wide text-ink-muted">
          {rewardTypeLabel(reward)}
        </span>
        <span className="truncate font-heading text-base font-bold text-ink">
          {rewardValueLabel(reward)}
        </span>
      </div>
      <Badge tone={earned ? 'accent' : 'muted'} className="shrink-0">
        {earned ? 'Earned' : 'Not yet earned'}
      </Badge>
    </div>
  );
}
