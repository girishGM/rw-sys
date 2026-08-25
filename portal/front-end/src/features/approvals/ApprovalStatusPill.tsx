/**
 * T-038 — the approval-request status pill.
 *
 * `components/StatusPill.tsx` (T-021) covers the seven **campaign** statuses. An approval request
 * has its own five (`ck_par_status`), only two of which overlap by name and neither of which means
 * quite the same thing — a `pending` request is not a `pending_approval` campaign, and `returned`
 * has no campaign-status counterpart at all (`campaign-state-machine.ts` explains why the column
 * cannot hold it). Rather than widen a shared design-system component this task does not own (R9),
 * this renders the five itself, following exactly the pattern `CampaignStatusPill` (T-037) set.
 *
 * Colour is always paired with text (04-FRONTEND.md §7, WCAG 1.4.1) — the label is the signal and
 * the colour is the reinforcement, never the other way round.
 */
import type { ApprovalStatus } from '@reward-portal/shared';
import { Badge, type BadgeTone } from '../../components/Badge';

const CONFIG: Record<ApprovalStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  returned: { label: 'Returned', tone: 'sky' },
  expired: { label: 'Expired', tone: 'slate' },
};

export interface ApprovalStatusPillProps {
  /** Always the request's `effectiveStatus`, never its stored `status` — see the schema's header
   * on why a stale `pending` row must read as `expired` (TC-14). */
  readonly status: ApprovalStatus;
  readonly className?: string;
}

export function ApprovalStatusPill({ status, className }: ApprovalStatusPillProps) {
  const config = CONFIG[status];
  return (
    <Badge tone={config.tone} className={className}>
      {config.label}
    </Badge>
  );
}
