/**
 * T-INT-022 — surfaces reward-tracking-service's own *confirmed* reward summary (leg 7) on the My
 * Rewards page, clearly labelled and kept entirely separate from the optimistic
 * `RewardListCard`/`groupRewardsByType` list below it (see `tracking-service/src/routes/rewards.ts`'s
 * own header for the full source-of-truth decision this task made: RTS's read API is a rollup —
 * grouped totals per tracker/component + reward kind — not a per-instance, markable-used ledger, so
 * it is shown as its own section rather than merged into/replacing the list).
 *
 * Renders nothing when `status: 'not_configured'` (this integration is optional, same "silently
 * absent" contract `promo-code-client` already established) — the page looks exactly as it did
 * before this task for anyone who hasn't configured it. `status: 'unavailable'` renders a small,
 * muted, non-alarming note (RTS being briefly unreachable is expected, not an error state worth a
 * warning colour). `status: 'ok'` renders one line per tracker/component with a real, non-fabricated
 * total (TC-1/TC-3).
 */
import { Card } from '../../components/Card';
import type { ConfirmedRewardsResult, ConfirmedRewardsSummaryComponent } from '../../types';

/** Mirrors reward-tracking-service's own display convention (`customer-rewards.controller.ts`'s
 * `formatForMessage`) — a stored `decimal(18,4)` string trimmed for display only, never re-parsed
 * for a calculation. */
function trimDecimal(raw: string): string {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed.toString() : raw;
}

function componentLine(component: ConfirmedRewardsSummaryComponent): string {
  const label = `${component.trackerCode} / ${component.componentCode}`;
  if (component.totalValue !== undefined) {
    const unit = component.unitCode ?? component.unitType ?? '';
    return `${label}: ${trimDecimal(component.totalValue)}${unit ? ` ${unit}` : ''} (${component.totalCount})`;
  }
  if (component.averageRatePercent !== undefined) {
    return `${label}: avg ${component.averageRatePercent}% (${component.totalCount})`;
  }
  return `${label}: ${component.totalCount} confirmed`;
}

export function ConfirmedRewardsSummaryCard({ result }: { result: ConfirmedRewardsResult }) {
  if (result.status === 'not_configured') return null;

  if (result.status === 'unavailable') {
    return (
      <Card className="p-4">
        <p className="font-body text-xs text-ink-muted">
          Confirmed reward-tracking summary is temporarily unavailable — showing your local rewards
          below.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-2 p-4">
      <p className="font-heading text-sm font-bold text-ink">Confirmed by reward-tracking</p>
      {result.components.length === 0 ? (
        <p className="font-body text-xs text-ink-muted">No confirmed rewards recorded yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {result.components.map((component) => (
            <li
              key={`${component.trackerCode}-${component.componentCode}-${component.rewardCategory}`}
              className="font-body text-xs text-ink-muted"
            >
              {componentLine(component)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
