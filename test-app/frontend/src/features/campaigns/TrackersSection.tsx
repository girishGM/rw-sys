/**
 * T-008 — the Trackers section (`ARCHITECTURE.md` §4), a `Card` listing one `TrackerCard` per
 * real tracker `GET /api/campaigns/:code` returned for this campaign.
 */
import { Card } from '../../components/Card';
import type { CampaignDetailTracker, RewardAssignment, TrackerProgressSummary } from '../../types';
import { TrackerCard } from './TrackerCard';

export interface TrackersSectionProps {
  trackers: readonly CampaignDetailTracker[];
  summaryByTrackerId: ReadonlyMap<number, TrackerProgressSummary>;
  campaignRewards: readonly RewardAssignment[];
}

export function TrackersSection({
  trackers,
  summaryByTrackerId,
  campaignRewards,
}: TrackersSectionProps) {
  return (
    <Card className="flex flex-col gap-5 p-5 sm:p-6">
      <h2 className="font-heading text-base font-semibold text-ink sm:text-[17px]">Trackers</h2>
      {trackers.length === 0 ? (
        <p className="font-body text-sm text-ink-muted">This campaign has no trackers yet.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {trackers.map((tracker) => (
            <TrackerCard
              key={tracker.trackerId}
              tracker={tracker}
              summary={summaryByTrackerId.get(tracker.trackerId)}
              campaignRewards={campaignRewards}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
