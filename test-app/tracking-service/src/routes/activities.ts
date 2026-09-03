/**
 * T-004 — `POST /api/activities`: the one write endpoint. Joins a customer's stored progress
 * (`ProgressStore`, completion flags only) with the real, live tracker/component structure
 * (`portal-client`'s cached journey, which carries the `activityId`/`activityName` a component
 * responds to) into the engine's `EvaluableTracker` shape, runs `evaluateTrackerActivity` per
 * tracker, persists any change, mints a reward on genuine completion, and emits the matching SSE
 * event — the full loop this task's Objective describes.
 *
 * T-013 — also `GET /api/activities?customerId=`: the per-customer history log every `POST` now
 * writes to (`ActivityHistoryStore`), most-recent-first, so T-010's Activity Simulator feed has a
 * real endpoint to call.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { AppState } from './app-state';
import { requireCustomerId } from './validation';
import {
  buildRewardForCompletedTracker,
  evaluateTrackerActivity,
  pickRewardAssignment,
  type EvaluableTracker,
} from '../engine';
import { activeCampaigns, ensureEnrolled } from '../data/campaign-sync';
import { completedComponentCount, trackerThreshold, type TrackerProgress } from '../data/progress';
import {
  describeActivity,
  type ActivityHistoryEntry,
  type ActivityProgressDelta,
} from '../data/activities';
import type { RewardLedgerEntry } from '../data/rewards';
import type { PortalCampaign, PortalCampaignJourney } from '../portal-client/types';

interface ActivityRequestBody {
  readonly customerId?: unknown;
  readonly activityType?: unknown;
  readonly merchant?: unknown;
  readonly amount?: unknown;
}

/** Alias kept locally so the rest of this file reads the same as before T-013 — the real
 * definition now lives in `data/activities.ts` (TC-1/TC-2's `data/` shouldn't depend on `routes/`
 * discipline applies the other way too: this route depends on `data/`, not the reverse). */
type ProgressDelta = ActivityProgressDelta;

/** Joins one stored `TrackerProgress` (completion flags) with its matching real journey tracker
 * (`activityId`/`activityName` per component) into the engine's pure input shape. `null` if the
 * journey no longer carries this tracker at all — defensive; not expected in the demo's fixed
 * 3-campaign roster, but a live portal is a live portal. */
function toEvaluableTracker(
  tracker: TrackerProgress,
  journey: PortalCampaignJourney,
): EvaluableTracker | null {
  const journeyTracker = journey.trackers.find((entry) => entry.id === tracker.trackerId);
  if (!journeyTracker) return null;

  const journeyComponentById = new Map(journeyTracker.components.map((entry) => [entry.id, entry]));
  return {
    trackerId: tracker.trackerId,
    trackerCode: tracker.trackerCode,
    trackerName: tracker.trackerName,
    completionLogic: tracker.completionLogic,
    completionThreshold: tracker.completionThreshold,
    components: tracker.components.map((component) => {
      const journeyComponent = journeyComponentById.get(component.componentId);
      return {
        componentId: component.componentId,
        componentCode: component.componentCode,
        componentName: component.componentName,
        completed: component.completed,
        activityId: journeyComponent?.activityId ?? null,
        activityName: journeyComponent?.activityName ?? null,
      };
    }),
  };
}

export function createActivitiesRouter(state: AppState): Router {
  const router = Router();

  router.post('/activities', async (req, res, next) => {
    try {
      const body = req.body as ActivityRequestBody;
      if (!requireCustomerId(body.customerId, res)) return;
      const customerId = body.customerId;

      if (typeof body.activityType !== 'string' || body.activityType.trim().length === 0) {
        res.status(400).json({ error: 'activityType is required' });
        return;
      }
      const activityType = body.activityType;
      const merchant = typeof body.merchant === 'string' ? body.merchant : null;
      const amount = typeof body.amount === 'number' ? body.amount : null;

      await ensureEnrolled(state.portal, state.progress, customerId);
      const realCampaigns = await activeCampaigns(state.portal);
      const realCampaignById = new Map<number, PortalCampaign>(
        realCampaigns.map((campaign) => [campaign.id, campaign]),
      );
      // Only campaigns still active right now accrue progress — one the portal has since
      // paused/completed/archived must not keep matching activities just because this customer
      // has an old `ProgressStore` row for it.
      const campaignsProgress = state.progress
        .getForCustomer(customerId)
        .filter((campaign) => realCampaignById.has(campaign.campaignId));

      const progressDeltas: ProgressDelta[] = [];
      const newRewards: RewardLedgerEntry[] = [];

      for (const campaign of campaignsProgress) {
        const journey = await state.portal.getCampaignJourney(campaign.campaignId);

        for (const tracker of campaign.trackers) {
          const evaluable = toEvaluableTracker(tracker, journey);
          if (!evaluable) continue;

          const result = evaluateTrackerActivity(evaluable, activityType);
          if (result.matchedComponentId === null) continue;

          const updatedTracker = state.progress.setComponentCompletion(
            customerId,
            campaign.campaignId,
            tracker.trackerId,
            result.matchedComponentId,
            true,
          );
          // Not expected — `toEvaluableTracker` above only ever matched against this same
          // (customerId, campaignId, trackerId, componentId) combination.
          if (!updatedTracker) continue;

          progressDeltas.push({
            campaignId: campaign.campaignId,
            campaignCode: campaign.campaignCode,
            campaignName: campaign.campaignName,
            trackerId: tracker.trackerId,
            trackerCode: tracker.trackerCode,
            trackerName: tracker.trackerName,
            componentId: result.matchedComponentId,
            completedCount: completedComponentCount(updatedTracker),
            threshold: trackerThreshold(updatedTracker),
            trackerCompleted: result.isNowComplete,
          });

          state.sse.emit(customerId, 'progress-updated', {
            campaignId: campaign.campaignId,
            trackerId: tracker.trackerId,
            componentId: result.matchedComponentId,
            completedCount: completedComponentCount(updatedTracker),
            threshold: trackerThreshold(updatedTracker),
            trackerCompleted: result.isNowComplete,
          });

          if (result.justCompleted) {
            const journeyTracker = journey.trackers.find((entry) => entry.id === tracker.trackerId);
            const assignment = journeyTracker
              ? pickRewardAssignment(journeyTracker.rewards, journey.campaignRewards)
              : null;
            const realCampaign = realCampaignById.get(campaign.campaignId);

            if (assignment && realCampaign) {
              const reward = await buildRewardForCompletedTracker(
                customerId,
                realCampaign,
                assignment,
                { promoCodeClient: state.promoCode },
              );
              state.rewards.addReward(reward);
              newRewards.push(reward);
              state.sse.emit(customerId, 'reward-earned', reward);
            }
          }
        }
      }

      const activityId = randomUUID();
      const matched = progressDeltas.length > 0;

      // T-013 — recorded on every call, matched or not, so the history log's count of "things
      // submitted" always matches what was actually sent, not just the ones that progressed.
      const historyEntry: ActivityHistoryEntry = {
        id: activityId,
        customerId,
        timestamp: new Date().toISOString(),
        activityType,
        merchant,
        amount,
        description: describeActivity(activityType, matched, newRewards),
        matched,
        progress: progressDeltas,
        rewards: newRewards,
      };
      state.activities.addEntry(historyEntry);

      res.status(200).json({
        data: {
          activityId,
          customerId,
          activityType,
          merchant,
          amount,
          matched,
          progress: progressDeltas,
          rewards: newRewards,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // T-013 — the customer's activity history, most-recent-first (`ActivityHistoryStore.
  // getForCustomer` already reverses insertion order). Same `?customerId=` + `requireCustomerId`
  // pattern every other read route in this file/folder uses (`routes/rewards.ts`, `routes/
  // dashboard.ts`).
  router.get('/activities', (req, res) => {
    if (!requireCustomerId(req.query.customerId, res)) return;
    const customerId = req.query.customerId as string;

    res.status(200).json({ data: state.activities.getForCustomer(customerId) });
  });

  return router;
}
