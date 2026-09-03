/**
 * T-003 — in-memory customer progress against real tracker components (ARCHITECTURE.md §3:
 * "Invented customer progress ... a progress record per tracker-component, against the *real*
 * tracker structure"). `componentId`/`trackerId`/`campaignId` below are always ids returned by
 * `portal-client` (TC-8) — never invented — only the `completed` flag per component is this
 * service's own state.
 *
 * T-004 owns *evaluating* an activity against this data (ARCHITECTURE.md §3's `completion_logic`/
 * `completion_threshold` engine); this module only owns the shape and the seed/read/write
 * primitives it's built from.
 */
import type { TrackerCompletionLogic } from '../portal-client/types';

export interface TrackerComponentProgress {
  readonly componentId: number;
  readonly componentCode: string;
  readonly componentName: string;
  readonly completed: boolean;
}

export interface TrackerProgress {
  readonly trackerId: number;
  readonly trackerCode: string;
  readonly trackerName: string;
  readonly completionLogic: TrackerCompletionLogic;
  readonly completionThreshold: number | null;
  readonly components: readonly TrackerComponentProgress[];
}

export interface CampaignProgress {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly campaignName: string;
  readonly trackers: readonly TrackerProgress[];
}

/** How many of a tracker's components are currently marked complete. */
export function completedComponentCount(tracker: TrackerProgress): number {
  return tracker.components.filter((component) => component.completed).length;
}

/** The denominator a UI should render next to {@link completedComponentCount} — the tracker's own
 * `completionThreshold` when it has one (`n_of`), otherwise every component counts (`all`/`any`). */
export function trackerThreshold(tracker: TrackerProgress): number {
  return tracker.completionThreshold ?? tracker.components.length;
}

/** Whether a tracker is complete under its own real `completionLogic` — the same three cases
 * ARCHITECTURE.md §3 names, applied here to read state (T-004 applies the same rule when writing
 * a new completion after an activity). */
export function isTrackerComplete(tracker: TrackerProgress): boolean {
  if (tracker.components.length === 0) return false;
  switch (tracker.completionLogic) {
    case 'all':
      return tracker.components.every((component) => component.completed);
    case 'any':
      return tracker.components.some((component) => component.completed);
    case 'n_of':
      return completedComponentCount(tracker) >= trackerThreshold(tracker);
  }
}

/** Keyed by {@link Customer.id}. A `Map`, not a plain object, so an unknown customer id is a
 * defined "not present" (`undefined`) rather than risking prototype-chain lookups. */
export class ProgressStore {
  private readonly byCustomer = new Map<string, CampaignProgress[]>();

  getForCustomer(customerId: string): readonly CampaignProgress[] {
    return this.byCustomer.get(customerId) ?? [];
  }

  /** Replaces the full set of campaign progress for a customer — used by the seed step and by
   * anything that recomputes a whole customer's state at once. */
  setForCustomer(customerId: string, campaigns: readonly CampaignProgress[]): void {
    this.byCustomer.set(customerId, [...campaigns]);
  }

  /** Appends campaigns this customer has no entry for yet, leaving every existing one (and its
   * accumulated completion state) untouched — `data/campaign-sync.ts`'s own enrollment step, so a
   * campaign the portal activates after this customer was first seen still gets tracked, without
   * resetting anything already in progress. */
  addCampaigns(customerId: string, campaigns: readonly CampaignProgress[]): void {
    if (campaigns.length === 0) return;
    const existing = this.byCustomer.get(customerId) ?? [];
    this.byCustomer.set(customerId, [...existing, ...campaigns]);
  }

  /**
   * Marks one component complete/incomplete for one customer, in place. Returns the updated
   * {@link TrackerProgress} so a caller (T-004's engine) can immediately check
   * {@link isTrackerComplete} without a second lookup, or `null` if the (customerId, campaignId,
   * trackerId, componentId) combination is not present.
   */
  setComponentCompletion(
    customerId: string,
    campaignId: number,
    trackerId: number,
    componentId: number,
    completed: boolean,
  ): TrackerProgress | null {
    const campaigns = this.byCustomer.get(customerId);
    const campaign = campaigns?.find((entry) => entry.campaignId === campaignId);
    const tracker = campaign?.trackers.find((entry) => entry.trackerId === trackerId);
    if (campaigns === undefined || campaign === undefined || tracker === undefined) return null;

    const updatedTracker: TrackerProgress = {
      ...tracker,
      components: tracker.components.map((component) =>
        component.componentId === componentId ? { ...component, completed } : component,
      ),
    };
    const updatedCampaign: CampaignProgress = {
      ...campaign,
      trackers: campaign.trackers.map((entry) =>
        entry.trackerId === trackerId ? updatedTracker : entry,
      ),
    };
    this.byCustomer.set(
      customerId,
      campaigns.map((entry) => (entry.campaignId === campaignId ? updatedCampaign : entry)),
    );
    return updatedTracker;
  }
}
