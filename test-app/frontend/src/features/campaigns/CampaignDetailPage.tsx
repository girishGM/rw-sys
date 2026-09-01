/**
 * T-008 — the Campaign Detail page (`/campaigns/:code`, `ARCHITECTURE.md` §4): the hero banner,
 * the campaign info card, the Trackers section and each tracker's Reward card. Combines two real
 * queries for one customer: `useCampaign(code, customerId)` (`GET /api/campaigns/:code` — the
 * full tracker/component tree) and `useCampaigns(customerId)` (`GET /api/campaigns` — the
 * server-evaluated `TrackerProgressSummary` per tracker, matched by `trackerId`), the same
 * `completedCount`/`threshold`/`completed` shape `TrackerRow` reads on the Dashboard. An unknown
 * `:code` (TC-6) is a real `404` from `apiClient` (`ApiError`) — rendered as a sensible not-found
 * state with a link back to `/campaigns`, not a crash or a blank page.
 *
 * `useCampaign` only gates itself on `Boolean(code)` (`lib/queries.ts`, T-006) — every existing
 * call site (`TrackerRow` on the Dashboard) only ever calls it once `customerId` is already known,
 * so it never had to gate on that too. This page mounts before that's true (`useCustomer()`'s own
 * roster fetch is still in flight on first paint), so `code` itself is held back to `undefined`
 * until `customerId` has settled — otherwise the query would fire once with no customer (an
 * incomplete, `customerId`-less snapshot of this campaign), then immediately re-fire under a
 * different cache key once the real `customerId` arrives, flashing the hero in and back out to a
 * loading state in between.
 */
import { Link, useParams } from 'react-router-dom';
import { useCustomer } from '../../app/useCustomer';
import { useCampaign, useCampaigns } from '../../lib/queries';
import { ApiError } from '../../lib/apiClient';
import { Card } from '../../components/Card';
import { ArrowRightIcon } from '../../components/icons';
import type { TrackerProgressSummary } from '../../types';
import { CampaignHero } from './CampaignHero';
import { CampaignInfoCard } from './CampaignInfoCard';
import { TrackersSection } from './TrackersSection';

function BackToCampaigns() {
  return (
    <Link
      to="/campaigns"
      className="inline-flex w-fit items-center gap-1.5 font-body text-sm font-semibold text-accent-strong hover:underline"
    >
      <ArrowRightIcon className="h-4 w-4 rotate-180" />
      Back to Campaigns
    </Link>
  );
}

export function CampaignDetailPage() {
  const { code } = useParams<{ code: string }>();
  const { customerId, isLoading: customerLoading } = useCustomer();
  const campaignQuery = useCampaign(customerLoading ? undefined : code, customerId);
  const campaignsQuery = useCampaigns(customerId);

  if (customerLoading || campaignQuery.isLoading || !campaignQuery.data) {
    if (campaignQuery.isError) {
      const notFound =
        campaignQuery.error instanceof ApiError && campaignQuery.error.status === 404;
      return (
        <div className="flex flex-col gap-4">
          <BackToCampaigns />
          <Card className="p-6">
            <h1 className="font-heading text-xl font-bold text-ink">
              {notFound ? 'Campaign not found' : "Couldn't load this campaign"}
            </h1>
            <p className="font-body text-sm text-ink-muted">
              {notFound
                ? `There's no campaign with the code "${code}".`
                : campaignQuery.error.message}
            </p>
          </Card>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <BackToCampaigns />
        <Card className="p-6" aria-busy="true">
          <p className="font-body text-sm text-ink-muted">Loading campaign…</p>
        </Card>
      </div>
    );
  }

  const campaign = campaignQuery.data;
  const summaryTrackers = campaignsQuery.data?.find(
    (entry) => entry.campaignCode === campaign.campaignCode,
  )?.progress?.trackers;
  const summaryByTrackerId = new Map<number, TrackerProgressSummary>(
    (summaryTrackers ?? []).map((tracker) => [tracker.trackerId, tracker]),
  );

  return (
    <div className="flex flex-col gap-6">
      <BackToCampaigns />
      <CampaignHero
        campaignCode={campaign.campaignCode}
        name={campaign.name}
        status={campaign.status}
      />
      <CampaignInfoCard
        description={campaign.description}
        startDate={campaign.startDate}
        endDate={campaign.endDate}
      />
      <TrackersSection
        trackers={campaign.trackers}
        summaryByTrackerId={summaryByTrackerId}
        campaignRewards={campaign.campaignRewards}
      />
    </div>
  );
}
