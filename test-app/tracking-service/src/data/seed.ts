/**
 * T-003 — builds the initial in-memory state (ARCHITECTURE.md §3 / T-003 scope: "Seed initial
 * state so the app has something to show before any activity is simulated"). Not wired into
 * `server.ts` by this task (out of scope — T-004 owns the REST/SSE surface and app startup); this
 * is the function T-004 calls once, at startup, with a real, logged-in {@link PortalClient}.
 */
import type { PortalClient } from '../portal-client/client';
import type { PortalCampaign, PortalCampaignJourney } from '../portal-client/types';
import { CUSTOMERS } from './customers';
import { ProgressStore, type CampaignProgress, type TrackerProgress } from './progress';
import { RewardsStore, rewardTypeFromUnitType, type RewardLedgerEntry } from './rewards';

/** The 3 real campaigns this service was seeded with for the demo (see the T-003 completion
 * report for the seed script that created them in `portal/back-end`) — looked up by their stable
 * business key (`campaignCode`), never by numeric database id, since that id is assigned by
 * whichever database this connects to. */
const DEMO_CAMPAIGN_CODES = {
  summerCashbackSprint: 'SUMMER_CASHBACK_SPRINT',
  referAndEarn: 'REFER_AND_EARN',
  weekendPromoBlitz: 'WEEKEND_PROMO_BLITZ',
} as const;

const PRIYA_SHAH_ID = 'priya-shah';

/** Priya Shah's own demo state (T-003 scope: "3/5, 1/3, 2/2 complete") — how many of each demo
 * campaign's (already sequence-ordered) components start out completed. Every other customer
 * starts enrolled with zero progress against the same real trackers. */
const PRIYA_COMPLETED_COUNT: Readonly<Record<string, number>> = {
  [DEMO_CAMPAIGN_CODES.summerCashbackSprint]: 3,
  [DEMO_CAMPAIGN_CODES.referAndEarn]: 1,
  [DEMO_CAMPAIGN_CODES.weekendPromoBlitz]: 2,
};

export interface DemoDataStores {
  readonly progress: ProgressStore;
  readonly rewards: RewardsStore;
}

function findRequiredCampaign(
  campaigns: readonly PortalCampaign[],
  campaignCode: string,
): PortalCampaign {
  const found = campaigns.find((campaign) => campaign.campaignCode === campaignCode);
  if (!found) {
    throw new Error(
      `seedDemoData: expected campaign "${campaignCode}" to exist in portal/back-end but it was ` +
        'not returned by GET /campaigns — see the T-003 completion report for the seed script ' +
        'that must have run against this environment.',
    );
  }
  return found;
}

function buildCampaignProgress(
  campaign: PortalCampaign,
  journey: PortalCampaignJourney,
  completedCount: number,
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

export async function seedDemoData(portalClient: PortalClient): Promise<DemoDataStores> {
  const progress = new ProgressStore();
  const rewards = new RewardsStore();

  const allCampaigns = await portalClient.getCampaigns();
  const demoCampaigns = Object.values(DEMO_CAMPAIGN_CODES).map((code) =>
    findRequiredCampaign(allCampaigns, code),
  );

  const journeysByCampaignId = new Map<number, PortalCampaignJourney>();
  for (const campaign of demoCampaigns) {
    journeysByCampaignId.set(campaign.id, await portalClient.getCampaignJourney(campaign.id));
  }

  for (const customer of CUSTOMERS) {
    const campaignProgress = demoCampaigns.map((campaign) => {
      const journey = journeysByCampaignId.get(campaign.id);
      if (!journey) {
        // Unreachable — every demoCampaigns entry was just fetched into the map above.
        throw new Error(`seedDemoData: journey missing for campaign ${campaign.id}`);
      }
      const completedCount =
        customer.id === PRIYA_SHAH_ID ? (PRIYA_COMPLETED_COUNT[campaign.campaignCode] ?? 0) : 0;
      return buildCampaignProgress(campaign, journey, completedCount);
    });
    progress.setForCustomer(customer.id, campaignProgress);
  }

  seedPriyaShahWeekendReward(demoCampaigns, journeysByCampaignId, rewards);

  return { progress, rewards };
}

/** Priya Shah's Weekend Promo Blitz tracker is seeded fully complete (2/2) — this is the matching
 * unused reward the task scope names explicitly ("an unused SAVE20 reward"). `SAVE20` itself is
 * invented (no real promo-code-generation system exists yet — BACKLOG.md); everything else about
 * it (`campaignId`, `type` derived from the real reward assignment's `unitType`) is real. */
function seedPriyaShahWeekendReward(
  demoCampaigns: readonly PortalCampaign[],
  journeysByCampaignId: ReadonlyMap<number, PortalCampaignJourney>,
  rewards: RewardsStore,
): void {
  const weekendCampaign = demoCampaigns.find(
    (campaign) => campaign.campaignCode === DEMO_CAMPAIGN_CODES.weekendPromoBlitz,
  );
  const weekendJourney = weekendCampaign ? journeysByCampaignId.get(weekendCampaign.id) : undefined;
  const weekendReward = weekendJourney?.trackers[0]?.rewards[0];

  if (!weekendCampaign || !weekendReward) return;

  const reward: RewardLedgerEntry = {
    id: 'seed-priya-shah-save20',
    customerId: PRIYA_SHAH_ID,
    campaignId: weekendCampaign.id,
    campaignCode: weekendCampaign.campaignCode,
    type: rewardTypeFromUnitType(weekendReward.unitType),
    value: 'SAVE20',
    currency: null,
    status: 'unused',
    issuedAt: weekendCampaign.startDate,
    expiresAt: weekendCampaign.endDate,
  };
  rewards.addReward(reward);
}
