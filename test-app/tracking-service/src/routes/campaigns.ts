/**
 * T-004 — `GET /api/campaigns` (list) / `GET /api/campaigns/:code` (detail): real campaign +
 * tracker data straight from `portal-client` (cached, T-003), merged with the given customer's
 * progress from `ProgressStore` when `?customerId=` is present. `customerId` is optional here
 * (unlike `dashboard`/`rewards`/`activities`) — a campaign/tracker's real structure is meaningful
 * on its own, with or without a specific customer's completion state layered on top.
 *
 * Both routes list from `activeCampaigns` (`data/campaign-sync.ts`), never
 * `state.portal.getCampaigns()` directly — a campaign the portal has paused/completed/archived
 * must stop appearing here the moment that's true in the portal, not just at this process's next
 * restart. When a customer id is given, `ensureEnrolled` runs first so a campaign this customer
 * has never been enrolled in (typically: activated after this process last saw them) still shows
 * real, zeroed progress instead of `progress: null`.
 *
 * ## T-INT-055 — the list route's per-tracker `completedCount`/`completed` now come from RAP
 *
 * Previously this route derived those two fields straight from `ProgressStore`'s own invented
 * per-component completion flags (`completedComponentCount`/`isTrackerComplete`) — the same
 * simulation Dashboard's `trackerProgress` moved off of under T-INT-021. Campaign Detail
 * (`TrackerCard`, fed by this route's `progress.trackers`) now reads the same real,
 * realtime-activity-processing-service ("RAP")-sourced completion state Dashboard already shows
 * for the identical tracker, joined via the shared `data/rap-tracker-progress.ts` helper
 * (`joinRapTrackerProgress`/`fetchRapProgress`/`resolveTenantId`) so the two pages can never
 * independently drift on what counts as "unknown" vs. "a real zero". `ProgressStore` still
 * supplies every *structural* field this route needs (tracker/component ids, codes, names,
 * `completionLogic`) — unchanged, only the completion-state fields moved. The `:code` detail
 * route is untouched: it only reports per-component completion (still real `ProgressStore` state,
 * a separate, out-of-scope concern per this task's own Scope "Out" — see `routes/activities.ts`,
 * the one remaining real writer/reader of that state), never a tracker-level summary.
 */
import { Router, type Response } from 'express';
import type { AppState } from './app-state';
import { requireCustomerId } from './validation';
import { activeCampaigns, ensureEnrolled } from '../data/campaign-sync';
import type { CampaignProgress } from '../data/progress';
import {
  fetchRapProgress,
  joinRapTrackerProgress,
  resolveTenantId,
} from '../data/rap-tracker-progress';
import type { RapCampaignProgress } from '../rap-progress-client';

/** `?customerId=` is optional on these two routes; when present it still has to be a real,
 * known customer (same rule every other route enforces) — `null` means "not provided at all". */
function optionalCustomerId(value: unknown, res: Response): string | null | false {
  if (value === undefined) return null;
  return requireCustomerId(value, res) ? value : false;
}

export function createCampaignsRouter(state: AppState): Router {
  const router = Router();

  router.get('/campaigns', async (req, res, next) => {
    try {
      const customerId = optionalCustomerId(req.query.customerId, res);
      if (customerId === false) return;
      if (customerId !== null) await ensureEnrolled(state.portal, state.progress, customerId);

      const realCampaigns = await activeCampaigns(state.portal);
      const progressByCode = new Map<string, CampaignProgress>(
        customerId !== null
          ? state.progress
              .getForCustomer(customerId)
              .map((campaign) => [campaign.campaignCode, campaign])
          : [],
      );

      // RAP progress is only meaningful for a specific customer — one fetch per campaign this
      // customer has a progress record for (not per tracker), same batching `dashboard.ts` uses.
      const tenantId = customerId !== null ? resolveTenantId(realCampaigns) : null;
      const rapProgressByCampaignCode: ReadonlyMap<string, RapCampaignProgress | null> =
        customerId !== null
          ? new Map(
              await Promise.all(
                [...progressByCode.values()].map(
                  async (campaign) =>
                    [
                      campaign.campaignCode,
                      await fetchRapProgress(
                        state.rapProgress,
                        tenantId,
                        customerId,
                        campaign.campaignCode,
                      ),
                    ] as const,
                ),
              ),
            )
          : new Map();

      const data = realCampaigns.map((campaign) => {
        const progress = progressByCode.get(campaign.campaignCode) ?? null;
        const rapProgress = rapProgressByCampaignCode.get(campaign.campaignCode) ?? null;
        return {
          campaignId: campaign.id,
          campaignCode: campaign.campaignCode,
          name: campaign.name,
          description: campaign.description,
          startDate: campaign.startDate,
          endDate: campaign.endDate,
          status: campaign.status,
          progress:
            progress === null
              ? null
              : {
                  trackers: progress.trackers.map((tracker) => ({
                    trackerId: tracker.trackerId,
                    trackerCode: tracker.trackerCode,
                    trackerName: tracker.trackerName,
                    completionLogic: tracker.completionLogic,
                    ...joinRapTrackerProgress(tracker, rapProgress),
                  })),
                },
        };
      });

      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  });

  router.get('/campaigns/:code', async (req, res, next) => {
    try {
      const customerId = optionalCustomerId(req.query.customerId, res);
      if (customerId === false) return;
      if (customerId !== null) await ensureEnrolled(state.portal, state.progress, customerId);

      const realCampaigns = await activeCampaigns(state.portal);
      const campaign = realCampaigns.find((entry) => entry.campaignCode === req.params.code);
      if (!campaign) {
        res.status(404).json({ error: `unknown campaign code "${req.params.code}"` });
        return;
      }

      const journey = await state.portal.getCampaignJourney(campaign.id);
      const progressCampaign =
        customerId !== null
          ? state.progress
              .getForCustomer(customerId)
              .find((entry) => entry.campaignId === campaign.id)
          : undefined;
      const completedByComponentId = new Map<number, boolean>();
      progressCampaign?.trackers.forEach((tracker) =>
        tracker.components.forEach((component) =>
          completedByComponentId.set(component.componentId, component.completed),
        ),
      );

      res.status(200).json({
        data: {
          campaignId: campaign.id,
          campaignCode: campaign.campaignCode,
          name: campaign.name,
          description: campaign.description,
          startDate: campaign.startDate,
          endDate: campaign.endDate,
          status: campaign.status,
          campaignRewards: journey.campaignRewards,
          trackers: journey.trackers.map((tracker) => ({
            trackerId: tracker.id,
            trackerCode: tracker.trackerCode,
            trackerName: tracker.name,
            description: tracker.description,
            completionLogic: tracker.completionLogic,
            completionThreshold: tracker.completionThreshold,
            rewards: tracker.rewards,
            components: tracker.components.map((component) => ({
              componentId: component.id,
              componentCode: component.componentCode,
              componentName: component.name,
              activityName: component.activityName,
              sequenceOrder: component.sequenceOrder,
              isMandatory: component.isMandatory,
              completed: completedByComponentId.get(component.id) ?? false,
            })),
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
