/**
 * T-004 — `GET /api/dashboard?customerId=`: everything the Dashboard page needs in one call
 * (active campaigns, reward counts, tracker progress summaries, expiring-soon rewards), a
 * deliberate aggregate per this task's implementation notes rather than several frontend calls.
 * Built entirely from this service's own in-memory state (`ProgressStore`/`RewardsStore`, already
 * seeded from real portal data by `data/seed.ts`) plus one cached `getCampaigns()` call for each
 * campaign's live `status` — no other live portal round-trip is needed per request.
 *
 * ## T-INT-021 — `trackerProgress`'s completion state now comes from RAP, not `ProgressStore`
 *
 * `ProgressStore` still supplies every *structural* field this route needs (tracker/component ids,
 * codes, names, `completionLogic`) — it is this app's real, portal-sourced tracker/component
 * config, unchanged by this task (see this task's own Implementation note 1 and Scope "Out"). What
 * moves off `ProgressStore` here is only the *completion state* (`completedCount`/`completed`),
 * previously this service's own invented flag, now sourced from realtime-activity-processing-
 * service's ("RAP") real, materialized progress (`rap-progress-client`, T-INT-020's gRPC/REST
 * surface). Reconciled by joining on `campaignCode`/`trackerCode` — RAP's own id scheme — against
 * the structural data already in hand, exactly as this task's Implementation note 1 describes,
 * never by inventing a second id scheme.
 *
 * Three distinct outcomes per tracker, never conflated (Implementation note 4 — "don't let a
 * customer believe they've made no progress when the truth is just 'couldn't reach RAP right
 * now'"):
 *   - RAP has no materialized progress at all for this tracker yet — a real, legitimate zero
 *     (`progressUnknown: false`, `completedCount: 0`).
 *   - RAP has real progress — reflected verbatim (`componentsCompletedCount`/`isCompleted`).
 *   - `state.rapProgress` is unset, or every attempted transport failed to reach RAP — real
 *     progress genuinely cannot be determined right now (`progressUnknown: true`,
 *     `completedCount`/`completed` both `null`). `threshold` is still reported in this case (it's
 *     structural, not completion state), so the UI can still show "?/N" rather than losing the
 *     denominator too.
 *
 * **Known, disclosed limitation of this task's own scope** (see this task's completion report's
 * "Deviations from spec"): `routes/activities.ts` and `routes/campaigns.ts` also read
 * `ProgressStore`'s own invented completion flags (for this app's own local, synchronous
 * demo-completion/reward-mint flow and for the Campaigns page, respectively) and are **not** in
 * this task's own "Files owned" list — `ProgressStore` therefore cannot be fully retired by this
 * task alone; it remains in place, still real and still used by those two call sites.
 */
import { Router } from 'express';
import type { AppState } from './app-state';
import { requireCustomerId } from './validation';
import { ensureEnrolled } from '../data/campaign-sync';
import { trackerThreshold, type CampaignProgress, type TrackerProgress } from '../data/progress';
import {
  RapProgressRequestError,
  RapProgressTransportNotAvailableError,
  RapProgressUnavailableError,
  RapProgressUnreachableError,
  type RapCampaignProgress,
} from '../rap-progress-client';

/** Invented — no design doc names an exact "expiring soon" window; 7 days is the common
 * e-commerce/loyalty-program convention and matches the "ends-soon" pill `UI-UX-DESIGN.md`
 * describes without a number attached. */
const EXPIRING_SOON_WINDOW_DAYS = 7;
const EXPIRING_SOON_WINDOW_MS = EXPIRING_SOON_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface DashboardTrackerProgress {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly campaignName: string;
  readonly trackerId: number;
  readonly trackerCode: string;
  readonly trackerName: string;
  readonly completionLogic: TrackerProgress['completionLogic'];
  readonly completedCount: number | null;
  readonly threshold: number;
  readonly completed: boolean | null;
  /** `true` when RAP's real progress genuinely could not be determined this request (not
   * configured, or every attempted transport unreachable) — see this file's own header. */
  readonly progressUnknown: boolean;
}

/** This app has exactly one portal `tenant_admin` login, so every campaign it ever sees belongs to
 * the same tenant — the same "resolved from whichever real campaign is on hand" sourcing
 * `reward-tracking-client`'s own `routes/rewards.ts` (T-INT-022) already established for the
 * identical problem (there is no per-customer tenant id anywhere in this app's own model). `null`
 * only when the portal has reported zero campaigns at all. */
function resolveTenantId(realCampaigns: readonly { tenantId: number }[]): number | null {
  return realCampaigns[0]?.tenantId ?? null;
}

/** Fetches this campaign's real progress from RAP, or `null` when it genuinely cannot be
 * determined right now (not configured, or every attempted transport unreachable) — never throws,
 * per Implementation note 4's "degrade gracefully, don't crash the page" contract. A
 * reached-but-rejected request (`RapProgressRequestError` — a real auth/config problem) is logged
 * more loudly than a plain unreachable, since that one likely needs a human to fix a secret/config
 * mismatch rather than just "RAP isn't running locally right now". */
async function fetchRapProgress(
  state: AppState,
  tenantId: number | null,
  customerId: string,
  campaignCode: string,
): Promise<RapCampaignProgress | null> {
  if (!state.rapProgress || tenantId === null) return null;

  try {
    return await state.rapProgress.getCampaignProgress({ customerId, tenantId, campaignCode });
  } catch (error) {
    if (
      error instanceof RapProgressUnreachableError ||
      error instanceof RapProgressUnavailableError ||
      error instanceof RapProgressTransportNotAvailableError
    ) {
      console.warn(
        `rap-progress-client: progress unavailable for customer=${customerId} ` +
          `campaign=${campaignCode} (rendering as unknown): ${error.message}`,
      );
    } else if (error instanceof RapProgressRequestError) {
      console.warn(
        `rap-progress-client: RAP rejected the progress request for customer=${customerId} ` +
          `campaign=${campaignCode} (rendering as unknown — check PROGRESS_API_AUTH_SECRET/` +
          `tenant config): ${error.message}`,
      );
    } else {
      console.warn(
        `rap-progress-client: unexpected error fetching progress for customer=${customerId} ` +
          `campaign=${campaignCode} (rendering as unknown): ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    return null;
  }
}

function toDashboardTrackerProgress(
  campaign: CampaignProgress,
  tracker: TrackerProgress,
  rapProgress: RapCampaignProgress | null,
): DashboardTrackerProgress {
  const threshold = trackerThreshold(tracker);
  const base = {
    campaignId: campaign.campaignId,
    campaignCode: campaign.campaignCode,
    campaignName: campaign.campaignName,
    trackerId: tracker.trackerId,
    trackerCode: tracker.trackerCode,
    trackerName: tracker.trackerName,
    completionLogic: tracker.completionLogic,
    threshold,
  };

  if (rapProgress === null) {
    return { ...base, completedCount: null, completed: null, progressUnknown: true };
  }

  // A tracker this customer has no materialized RAP progress on yet is a real, legitimate zero
  // (RAP's own contract: "Empty trackers is a normal response") — never treated as unknown.
  const rapTracker = rapProgress.trackers.find(
    (entry) => entry.trackerCode === tracker.trackerCode,
  );
  return {
    ...base,
    completedCount: rapTracker?.componentsCompletedCount ?? 0,
    completed: rapTracker?.isCompleted ?? false,
    progressUnknown: false,
  };
}

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

      const tenantId = resolveTenantId(realCampaigns);
      // One RAP fetch per campaign (not per tracker) — RAP's `GetCampaignProgress` already
      // returns every tracker for a campaign in one call.
      const rapProgressByCampaignCode = new Map(
        await Promise.all(
          campaignProgress.map(
            async (campaign) =>
              [
                campaign.campaignCode,
                await fetchRapProgress(state, tenantId, customerId, campaign.campaignCode),
              ] as const,
          ),
        ),
      );

      const trackerProgress = campaignProgress.flatMap((campaign) =>
        campaign.trackers.map((tracker) =>
          toDashboardTrackerProgress(
            campaign,
            tracker,
            rapProgressByCampaignCode.get(campaign.campaignCode) ?? null,
          ),
        ),
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
