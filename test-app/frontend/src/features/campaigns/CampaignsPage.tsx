/**
 * T-008 — the Campaigns list (`/campaigns`, `ARCHITECTURE.md` §4: "list of running/past campaigns
 * (name, description, region, start/end dates, status badge), real data"). `region` is not a real
 * field this app has (`CampaignInfoCard.tsx`'s header explains why) so it is omitted here too, the
 * same documented decision. Driven by `useCampaigns(customerId)` — `GET /api/campaigns`, real
 * `portal/back-end` campaign config (TC-1).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCustomer } from '../../app/useCustomer';
import { useCampaigns } from '../../lib/queries';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { campaignStatusTone } from './campaignStatus';
import { getCampaignTheme } from './campaignTheme';
import { formatDateRange } from './formatDateRange';

function CampaignsPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink sm:text-[28px]">Campaigns</h1>
        <p className="font-body text-sm text-ink-muted">
          Every campaign currently running, plus what it takes to earn its reward.
        </p>
      </div>
      {children}
    </div>
  );
}

export function CampaignsPage() {
  const { customerId, isLoading: customerLoading } = useCustomer();
  const campaignsQuery = useCampaigns(customerId);

  if (customerLoading || campaignsQuery.isLoading || !campaignsQuery.data) {
    // `campaignsQuery.isError` is checked *inside* this branch, not as a separate `if` after it —
    // an errored query's `data` stays `undefined` forever, so a later, sibling `if
    // (campaignsQuery.isError)` would never be reached (the branch above always returns first).
    if (campaignsQuery.isError) {
      return (
        <CampaignsPageShell>
          <Card className="p-6">
            <p className="font-body text-sm text-warn-strong">
              Couldn&apos;t load campaigns: {campaignsQuery.error.message}
            </p>
          </Card>
        </CampaignsPageShell>
      );
    }
    return (
      <CampaignsPageShell>
        <Card className="p-6" aria-busy="true">
          <p className="font-body text-sm text-ink-muted">Loading campaigns…</p>
        </Card>
      </CampaignsPageShell>
    );
  }

  const campaigns = campaignsQuery.data;

  return (
    <CampaignsPageShell>
      {campaigns.length === 0 ? (
        <Card className="p-6">
          <p className="font-body text-sm text-ink-muted">No campaigns to show right now.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {campaigns.map((campaign) => {
            const { Icon, gradientClassName } = getCampaignTheme(campaign.campaignCode);
            return (
              <li key={campaign.campaignId}>
                <Link to={`/campaigns/${campaign.campaignCode}`} className="block">
                  <Card className="flex items-center gap-4 p-5 transition-colors hover:bg-surface-2 sm:p-6">
                    <span
                      aria-hidden="true"
                      className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-chip bg-gradient-to-br text-white ${gradientClassName}`}
                    >
                      <Icon className="h-6 w-6" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-heading text-base font-bold text-ink">
                          {campaign.name}
                        </span>
                        <Badge tone={campaignStatusTone(campaign.status)} className="capitalize">
                          {campaign.status}
                        </Badge>
                      </div>
                      {campaign.description && (
                        <p className="truncate font-body text-sm text-ink-muted">
                          {campaign.description}
                        </p>
                      )}
                      <p className="font-body text-xs text-ink-muted">
                        {formatDateRange(campaign.startDate, campaign.endDate)}
                      </p>
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </CampaignsPageShell>
  );
}
