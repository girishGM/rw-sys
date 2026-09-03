/**
 * Keeps a customer's {@link ProgressStore} entries in sync with whichever campaigns the portal
 * currently reports `active` — the mechanism `data/seed.ts`'s fixed `DEMO_CAMPAIGN_CODES` never
 * had. Before this, the 3 demo campaigns were the only campaigns this app could ever show, seeded
 * once at boot; a campaign a maker activates in the portal afterwards was invisible here until the
 * process restarted (and even then, only if someone also added its code to that hardcoded list),
 * and a campaign the portal paused/completed kept showing anyway.
 *
 * `routes/campaigns.ts`/`routes/activities.ts`/`routes/dashboard.ts` all call {@link
 * ensureEnrolled} before reading a customer's progress, and use {@link activeCampaigns} — never
 * `portal.getCampaigns()` directly — for "which campaigns exist right now". `PortalClient`'s own
 * 5-minute cache (`portal-client/client.ts`) is what makes repeated calls here cheap; nothing in
 * this module adds a second cache on top of it.
 */
import type { PortalDataSource } from '../engine';
import type { PortalCampaign, PortalCampaignJourney } from '../portal-client/types';
import { ProgressStore, type CampaignProgress, type TrackerProgress } from './progress';

/** The portal's currently-active campaigns — the one place "which campaigns exist" is decided, so
 * every caller (seed, every route) agrees on the same filter rather than each re-deriving it. */
export async function activeCampaigns(portal: PortalDataSource): Promise<PortalCampaign[]> {
  const all = await portal.getCampaigns();
  return all.filter((campaign) => campaign.status === 'active');
}

/** Builds one campaign's `CampaignProgress`, `completedCount` components already marked complete
 * (in `sequenceOrder`) — `0` for a freshly-enrolled customer, same shape `data/seed.ts`'s own
 * `PRIYA_COMPLETED_COUNT` head start uses for the campaigns it still special-cases. */
export function buildCampaignProgress(
  campaign: PortalCampaign,
  journey: PortalCampaignJourney,
  completedCount = 0,
): CampaignProgress {
  const trackers: TrackerProgress[] = journey.trackers.map((tracker) => {
    const componentsInOrder = [...tracker.components].sort(
      (a, b) => a.sequenceOrder - b.sequenceOrder,
    );
    return {
      trackerId: tracker.id,
      trackerCode: tracker.trackerCode,
      trackerName: tracker.name,
      completionLogic: tracker.completionLogic,
      completionThreshold: tracker.completionThreshold,
      components: componentsInOrder.map((component, index) => ({
        componentId: component.id,
        componentCode: component.componentCode,
        componentName: component.name,
        completed: index < completedCount,
      })),
    };
  });

  return {
    campaignId: campaign.id,
    campaignCode: campaign.campaignCode,
    campaignName: campaign.name,
    trackers,
  };
}

/**
 * Ensures `customerId` has a `ProgressStore` entry for every currently-active campaign,
 * initializing any missing one at zero progress — never touching an entry that already exists, so
 * this is safe to call on every request. Cheap once `portal.getCampaigns()`/`getCampaignJourney()`
 * are warm; the only real work happens the first time a given (customer, campaign) pair is seen.
 */
export async function ensureEnrolled(
  portal: PortalDataSource,
  progress: ProgressStore,
  customerId: string,
): Promise<void> {
  const active = await activeCampaigns(portal);
  const existingIds = new Set(progress.getForCustomer(customerId).map((entry) => entry.campaignId));
  const missing = active.filter((campaign) => !existingIds.has(campaign.id));
  if (missing.length === 0) return;

  const additions: CampaignProgress[] = [];
  for (const campaign of missing) {
    const journey = await portal.getCampaignJourney(campaign.id);
    additions.push(buildCampaignProgress(campaign, journey));
  }
  progress.addCampaigns(customerId, additions);
}
