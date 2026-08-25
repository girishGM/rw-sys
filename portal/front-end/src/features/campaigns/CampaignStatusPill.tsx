/**
 * T-037 — the status pill, extended for the one state T-021's `StatusPill` cannot know about.
 *
 * `components/StatusPill.tsx` covers the six `ck_tc_status` values plus `rejected`. It has no
 * `returned`, because `returned` is not a stored campaign status at all — it is derived from the
 * campaign's last approval decision (`campaign.schema.ts#CAMPAIGN_STATUSES`, and
 * `campaign-state-machine.ts` for why the column cannot hold it under R1).
 *
 * Rather than widening a shared design-system component this task does not own (R9), this wrapper
 * renders the derived state itself and delegates every other value to `StatusPill` unchanged — so
 * the six statuses keep exactly the colours and labels every other screen uses.
 */
import type { CampaignEffectiveStatus } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { StatusPill, type CampaignStatus as PillStatus } from '../../components/StatusPill';

export interface CampaignStatusPillProps {
  readonly status: CampaignEffectiveStatus;
  readonly className?: string;
}

export function CampaignStatusPill({ status, className }: CampaignStatusPillProps) {
  if (status === 'returned') {
    // Amber, and paired with text rather than colour alone (04-FRONTEND.md §7, WCAG 1.4.1).
    return (
      <Badge tone="warning" className={className}>
        Returned for rework
      </Badge>
    );
  }
  return <StatusPill status={status as PillStatus} className={className} />;
}
