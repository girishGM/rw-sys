/**
 * T-004 — `GET /api/dashboard?customerId=`: everything the Dashboard page needs in one call
 * (active campaigns, reward counts, tracker progress summaries, expiring-soon rewards), a
 * deliberate aggregate per this task's implementation notes rather than several frontend calls.
 * Built entirely from this service's own in-memory state (`ProgressStore`/`RewardsStore`, already
 * seeded from real portal data by `data/seed.ts`) plus one cached `getCampaigns()` call for each
 * campaign's live `status` — no other live portal round-trip is needed per request.
 */
import { Router } from 'express';
import type { AppState } from './app-state';
import { requireCustomerId } from './validation';
import { ensureEnrolled } from '../data/campaign-sync';
import { completedComponentCount, isTrackerComplete, trackerThreshold } from '../data/progress';

/** Invented — no design doc names an exact "expiring soon" window; 7 days is the common
 * e-commerce/loyalty-program convention and matches the "ends-soon" pill `UI-UX-DESIGN.md`
 * describes without a number attached. */
const EXPIRING_SOON_WINDOW_DAYS = 7;
const EXPIRING_SOON_WINDOW_MS = EXPIRING_SOON_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export function createDashboardRouter(state: AppState): Router {
  const router = Router();

  router.get('/dashboard', async (req, res, next) => {
    try {
      if (!requireCustomerId(req.query.customerId, res)) return;
      const customerId = req.query.customerId as string;
      await ensureEnrolled(state.portal, state.progress, customerId);

      const realCampaigns = await state.portal.getCampaigns();
      const statusByCode = new Map(
        realCampaigns.map((campaign) => [campaign.campaignCode, campaign]),
      );

      const campaignProgress = state.progress.getForCustomer(customerId);
      const rewards = state.rewards.getForCustomer(customerId);

      const activeCampaigns: Array<{
        campaignId: number;
        campaignCode: string;
        campaignName: string;
        startDate: string;
        endDate: string;
        status: string;
      }> = [];
      for (const campaign of campaignProgress) {
        const real = statusByCode.get(campaign.campaignCode);
        if (real === undefined || real.status !== 'active') continue;
        activeCampaigns.push({
          campaignId: campaign.campaignId,
          campaignCode: campaign.campaignCode,
          campaignName: campaign.campaignName,
          startDate: real.startDate,
          endDate: real.endDate,
          status: real.status,
        });
      }

      const trackerProgress = campaignProgress.flatMap((campaign) =>
        campaign.trackers.map((tracker) => ({
          campaignId: campaign.campaignId,
          campaignCode: campaign.campaignCode,
          campaignName: campaign.campaignName,
          trackerId: tracker.trackerId,
          trackerCode: tracker.trackerCode,
          trackerName: tracker.trackerName,
          completionLogic: tracker.completionLogic,
          completedCount: completedComponentCount(tracker),
          threshold: trackerThreshold(tracker),
          completed: isTrackerComplete(tracker),
        })),
      );

      const now = Date.now();
      const expiringSoon = rewards
        .filter((reward) => {
          if (reward.status !== 'unused' || reward.expiresAt === null) return false;
          const msUntilExpiry = new Date(reward.expiresAt).getTime() - now;
          return msUntilExpiry >= 0 && msUntilExpiry <= EXPIRING_SOON_WINDOW_MS;
        })
        .sort(
          (a, b) =>
            new Date(a.expiresAt as string).getTime() - new Date(b.expiresAt as string).getTime(),
        );

      const rewardCounts = {
        total: rewards.length,
        unused: rewards.filter((reward) => reward.status === 'unused').length,
        used: rewards.filter((reward) => reward.status === 'used').length,
      };

      res.status(200).json({
        data: {
          customerId,
          activeCampaigns,
          rewardCounts,
          trackerProgress,
          expiringSoon,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
