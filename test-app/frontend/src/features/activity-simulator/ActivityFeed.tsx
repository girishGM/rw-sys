/**
 * T-010 — the Activity Simulator's live feed: real history for the selected customer
 * (`useActivities`, `GET /api/activities`, T-013), most-recent-first (the API's own order,
 * `data/activities.ts`'s `getForCustomer` doc comment — no client-side re-sort needed). Loading/
 * error/empty are each their own distinct state (TC-4/TC-5 both depend on "empty ≠ error ≠ still
 * loading" being visibly different, not one generic placeholder).
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { Card } from '../../components/Card';
import type { ActivityHistoryEntry } from '../../types';
import { ActivityFeedItem } from './ActivityFeedItem';

export interface ActivityFeedProps {
  readonly query: UseQueryResult<readonly ActivityHistoryEntry[]>;
}

export function ActivityFeed({ query }: ActivityFeedProps) {
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="font-heading text-lg font-bold text-ink">Activity feed</h2>
        <p className="font-body text-sm text-ink-muted">
          Every activity you&apos;ve fired for this customer, most recent first.
        </p>
      </div>

      {query.isLoading || (!query.data && !query.isError) ? (
        <p className="font-body text-sm text-ink-muted" aria-busy="true">
          Loading activity…
        </p>
      ) : query.isError ? (
        <p className="font-body text-sm text-warn-strong">
          Couldn&apos;t load this customer&apos;s activity: {query.error.message}
        </p>
      ) : query.data.length === 0 ? (
        <p className="font-body text-sm text-ink-muted">
          No activity yet — fire one above to see it show up here live.
        </p>
      ) : (
        <ul className="flex flex-col">
          {query.data.map((entry) => (
            <ActivityFeedItem key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </Card>
  );
}
