/** T-004 — `GET /api/rewards?customerId=`: that customer's full reward ledger (TC-4), exactly as
 * `RewardsStore` holds it (no filtering/sorting — the frontend groups by type/status itself,
 * ARCHITECTURE.md §4's "My Rewards" page).
 *
 * ## T-INT-022 — `data/rewards.ts`'s role now that reward-tracking-service (RTS) exists
 *
 * **Decision (documented per this task's own implementation note 2): keep `RewardsStore` as this
 * app's optimistic-UI ledger; RTS becomes the source of truth for *confirmed* rewards, surfaced
 * separately, not merged into the existing array.**
 *
 * Two real constraints ruled out a merge/replace:
 *   1. `RewardsStore` entries are minted the instant a tracker completes (`engine/reward.ts`) — a
 *      genuinely optimistic "a reward is likely coming" signal, well before RR has actually
 *      dispatched an outcome to RTS (leg 6, T-INT-002). Retiring it outright would make the My
 *      Rewards page go blank the moment a tracker completes, until RTS's own pipeline catches up —
 *      a worse UX than today's, not a neutral one.
 *   2. RTS's own confirmed-reward read API (`customer-rewards.controller.ts`) is a **rollup**, not a
 *      per-instance ledger — `shapeRewardGroup`'s own documented contract only ever emits grouped
 *      `totalValue`/`totalCount` per tracker/component + reward kind, never a per-reward `id` or a
 *      `used`/`unused` status. There is no way to reconcile one specific `RewardsStore` entry
 *      against one specific RTS row (no shared correlation id exists on either side) — RTS answers
 *      "how much has this customer earned", not "which individual rewards, redeemable or not".
 *      `RewardListCard`'s used/unused toggle has no RTS equivalent to source from at all.
 *
 * So: `GET /api/rewards` is unchanged (the existing optimistic ledger, unaffected). A new
 * `GET /api/rewards/confirmed` calls RTS's real `.../rewards/summary` and reports it under its own
 * envelope, clearly labelled by `status`, so a caller can show "RTS confirms: ..." UI without ever
 * conflating it with the optimistic list above (TC-5's "existing `data/rewards.ts`-based tests"
 * requirement: unchanged, still green, per the "(b) keep it as a clearly-labelled optimistic layer"
 * option this task's own note 2 offers).
 */
import { Router } from 'express';
import type { AppState } from './app-state';
import { requireCustomerId } from './validation';
import {
  RewardTrackingRequestError,
  RewardTrackingTransportNotAvailableError,
  RewardTrackingUnreachableError,
} from '../reward-tracking-client';
import type { CustomerRewardsSummary } from '../reward-tracking-client';

/** The `/rewards/confirmed` envelope — always HTTP 200 (this endpoint never surfaces a 5xx to the
 * caller for an upstream RTS failure, TC-2): `status` alone tells the caller which of the 3 real
 * states it's in. */
export type ConfirmedRewardsResult =
  | { readonly status: 'not_configured' }
  | { readonly status: 'unavailable'; readonly message: string }
  | ({ readonly status: 'ok' } & CustomerRewardsSummary);

/** This app has exactly one portal `tenant_admin` login, so every campaign it ever sees belongs to
 * the same tenant (`portal-client`'s own single-tenant scope) — there is no per-customer tenant id
 * anywhere in this app's own model. Resolves it from whichever real campaign is on hand rather than
 * inventing a config var for a value the portal already tells this app on every `getCampaigns()`
 * call. Returns `null` only when the portal has reported zero campaigns at all (a genuinely empty
 * environment) — RTS auth requires *some* real tenant id, so this is treated the same as
 * "unavailable", never guessed. */
async function resolveTenantId(state: AppState): Promise<number | null> {
  const campaigns = await state.portal.getCampaigns();
  return campaigns[0]?.tenantId ?? null;
}

export function createRewardsRouter(state: AppState): Router {
  const router = Router();

  router.get('/rewards', (req, res) => {
    if (!requireCustomerId(req.query.customerId, res)) return;
    const customerId = req.query.customerId as string;

    res.status(200).json({ data: state.rewards.getForCustomer(customerId) });
  });

  router.get('/rewards/confirmed', async (req, res, next) => {
    try {
      if (!requireCustomerId(req.query.customerId, res)) return;
      const customerId = req.query.customerId as string;
      const campaignCode =
        typeof req.query.campaignCode === 'string' ? req.query.campaignCode : undefined;

      if (!state.rewardTracking) {
        const result: ConfirmedRewardsResult = { status: 'not_configured' };
        res.status(200).json({ data: result });
        return;
      }

      const tenantId = await resolveTenantId(state);
      if (tenantId === null) {
        const result: ConfirmedRewardsResult = {
          status: 'unavailable',
          message: 'no campaign/tenant context available from the portal yet',
        };
        res.status(200).json({ data: result });
        return;
      }

      try {
        const summary = await state.rewardTracking.getCustomerRewardsSummary({
          customerId,
          tenantId,
          campaignCode,
        });
        const result: ConfirmedRewardsResult = { status: 'ok', ...summary };
        res.status(200).json({ data: result });
      } catch (err) {
        // Every failure mode this client can throw (unreachable, a rejected request, an
        // unavailable transport per TC-4) degrades to the same graceful `unavailable` state —
        // never a crash, never a 5xx surfaced to the frontend (TC-2).
        const message =
          err instanceof RewardTrackingUnreachableError ||
          err instanceof RewardTrackingRequestError ||
          err instanceof RewardTrackingTransportNotAvailableError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'reward-tracking-service request failed';
        const result: ConfirmedRewardsResult = { status: 'unavailable', message };
        res.status(200).json({ data: result });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
