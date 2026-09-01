/**
 * T-007 — the "Your Progress" trackers widget (`ARCHITECTURE.md` §4), a `Card` listing one
 * `TrackerRow` per real tracker `useDashboard` returned for the selected customer.
 */
import { Card } from '../../components/Card';
import type { DashboardTrackerProgress } from '../../types';
import { TrackerRow } from './TrackerRow';

export interface TrackersWidgetProps {
  trackers: readonly DashboardTrackerProgress[];
  customerId: string | null;
}

export function TrackersWidget({ trackers, customerId }: TrackersWidgetProps) {
  return (
    <Card className="flex flex-col gap-5 p-5 sm:p-6">
      <h2 className="font-heading text-base font-semibold text-ink sm:text-[17px]">
        Your Progress
      </h2>
      {trackers.length === 0 ? (
        <p className="font-body text-sm text-ink-muted">No trackers to show yet.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {trackers.map((tracker) => (
            <TrackerRow
              key={`${tracker.campaignId}-${tracker.trackerId}`}
              tracker={tracker}
              customerId={customerId}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
