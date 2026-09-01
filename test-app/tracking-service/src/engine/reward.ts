/**
 * T-004 — builds a new {@link RewardLedgerEntry} for a tracker that just completed, deriving
 * `type` from the campaign's real reward assignment (`portal-client`'s `unitType`, via T-003's own
 * `rewardTypeFromUnitType`) rather than inventing it. The *type* is always real; the display
 * *value* (a dollar amount, a promo code, a point count) is necessarily invented — same as
 * `data/seed.ts`'s own precedent (`SAVE20`): no `amount`/currency/promo-code-generation system
 * exists anywhere in this environment's `reward_config` seed data (see this task's completion
 * report and `BACKLOG.md`'s "no real promo-code-generation system exists yet").
 */
import { randomUUID } from 'node:crypto';
import { rewardTypeFromUnitType, type RewardLedgerEntry, type RewardType } from '../data/rewards';
import type { PortalCampaign, PortalRewardAssignment } from '../portal-client/types';

/** Invented — no `reward_config.reward_versions.amount`/currency is populated for the 3 demo
 * campaigns' reward assignments in this environment (confirmed live: `amount` is `null` on all of
 * them). A fixed, predictable value rather than a random one so a QA screenshot/API response is
 * reproducible run to run. */
const DEMO_CASHBACK_AMOUNT = '25.00';
const DEMO_CASHBACK_CURRENCY = 'USD';
const DEMO_POINTS_AMOUNT = '500';

/** Invented promo-code discounts, in the same "SAVE##" style as `data/seed.ts`'s seeded `SAVE20` —
 * picked (not always the same one) via the injectable `random` below so repeated demo runs don't
 * all show the identical code. */
const PROMO_CODE_DISCOUNTS = [10, 15, 20, 25, 30] as const;

export interface RewardGenerationDeps {
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
  /** `[0, 1)`, same contract as `Math.random`. Injectable so promo-code selection is deterministic
   * in tests. */
  readonly random?: () => number;
}

/** Picks which real reward assignment a just-completed tracker awards: the tracker-level one
 * (every demo tracker has exactly one), falling back to a campaign-level assignment if the tracker
 * itself carries none. Only `status: 'active'` assignments are eligible — a withdrawn/inactive
 * assignment is not a real, awardable reward. */
export function pickRewardAssignment(
  trackerRewards: readonly PortalRewardAssignment[],
  campaignRewards: readonly PortalRewardAssignment[],
): PortalRewardAssignment | null {
  return (
    trackerRewards.find((reward) => reward.status === 'active') ??
    campaignRewards.find((reward) => reward.status === 'active') ??
    null
  );
}

function deriveValueAndCurrency(
  type: RewardType,
  assignment: PortalRewardAssignment,
  random: () => number,
): { value: string; currency: string | null } {
  switch (type) {
    case 'cashback':
      // Real `amount` wins if a future seed ever populates it; invented fallback otherwise.
      return { value: assignment.amount ?? DEMO_CASHBACK_AMOUNT, currency: DEMO_CASHBACK_CURRENCY };
    case 'points':
      return { value: assignment.amount ?? DEMO_POINTS_AMOUNT, currency: null };
    case 'promo_code': {
      const index = Math.min(
        Math.floor(random() * PROMO_CODE_DISCOUNTS.length),
        PROMO_CODE_DISCOUNTS.length - 1,
      );
      return { value: `SAVE${PROMO_CODE_DISCOUNTS[index]}`, currency: null };
    }
  }
}

/** Builds the ledger entry itself. `campaignId`/`campaignCode`/`type` are always real (traced back
 * to the real campaign + the real reward assignment's `unitType`); `expiresAt` reuses the
 * campaign's own real `endDate` (same choice `data/seed.ts` made for its one seeded reward);
 * `issuedAt` is the actual moment this fired, not an invented date. */
export function buildRewardForCompletedTracker(
  customerId: string,
  campaign: PortalCampaign,
  assignment: PortalRewardAssignment,
  deps: RewardGenerationDeps = {},
): RewardLedgerEntry {
  const now = deps.now ?? (() => new Date());
  const idGenerator = deps.idGenerator ?? randomUUID;
  const random = deps.random ?? Math.random;

  const type = rewardTypeFromUnitType(assignment.unitType);
  const { value, currency } = deriveValueAndCurrency(type, assignment, random);

  return {
    id: idGenerator(),
    customerId,
    campaignId: campaign.id,
    campaignCode: campaign.campaignCode,
    type,
    value,
    currency,
    status: 'unused',
    issuedAt: now().toISOString(),
    expiresAt: campaign.endDate,
  };
}
