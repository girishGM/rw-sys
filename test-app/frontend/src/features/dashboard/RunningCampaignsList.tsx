/**
 * T-007 — the "Running Campaigns" list (`ARCHITECTURE.md` §4: "a running-campaigns list (banner
 * chip + name + dates + status)"), fed by `useDashboard`'s real `activeCampaigns`
 * (`GET /api/dashboard` already filters this to campaigns whose real portal status is `active` —
 * see `tracking-service/src/routes/dashboard.ts`).
 */
import { Link } from 'react-router-dom';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import type { ActiveCampaignSummary } from '../../types';
import { getCampaignTheme } from './campaignTheme';
import { formatDateRange } from './formatDateRange';

export interface RunningCampaignsListProps {
  campaigns: readonly ActiveCampaignSummary[];
}

export function RunningCampaignsList({ campaigns }: RunningCampaignsListProps) {
  return (
    <Card className="flex flex-col gap-4 p-5 sm:p-6">
      <h2 className="font-heading text-base font-semibold text-ink sm:text-[17px]">
        Running Campaigns
      </h2>
      {campaigns.length === 0 ? (
        <p className="font-body text-sm text-ink-muted">No campaigns are running right now.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {campaigns.map((campaign) => {
            const { Icon, gradientClassName } = getCampaignTheme(campaign.campaignCode);
            return (
              <li key={campaign.campaignId}>
                <Link
                  to={`/campaigns/${campaign.campaignCode}`}
                  className="flex items-center gap-3 rounded-chip p-2 transition-colors hover:bg-surface-2"
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-chip bg-gradient-to-br text-white ${gradientClassName}`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-body text-sm font-semibold text-ink">
                      {campaign.campaignName}
                    </span>
                    <span className="font-body text-xs text-ink-muted">
                      {formatDateRange(campaign.startDate, campaign.endDate)}
                    </span>
                  </div>
                  <Badge tone="accent" className="shrink-0 capitalize">
                    {campaign.status}
                  </Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
