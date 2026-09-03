/**
 * T-004 — builds a new {@link RewardLedgerEntry} for a tracker that just completed, deriving
 * `type` from the campaign's real reward assignment (`portal-client`'s `unitType`, via T-003's own
 * `rewardTypeFromUnitType`) rather than inventing it. The *type* is always real; a cashback amount
 * and a points count are still invented (`amount`/currency stay unpopulated in this environment's
 * `reward_config` seed data — see `data/seed.ts`'s own precedent).
 *
 * A `promo_code` reward's *value* is different: when the maker attached a real
 * `promo_code_config` (journey's `promoCodeConfigId`, surfaced by portal T-165/this task's own
 * portal-side change), this now calls promo-code-service's real
 * `POST /api/v1/promo-codes/generate` (T-PC-056) for an actual, database-backed code — see
 * {@link resolvePromoCode}. The invented `SAVE##` fallback still exists for a reward with no
 * config bound, no client configured (`RewardGenerationDeps.promoCodeClient` unset), or a
 * generation call that fails — this must never be the one thing that stops a customer's tracker
 * completion from producing *some* reward.
 */
import { randomUUID } from 'node:crypto';
import { rewardTypeFromUnitType, type RewardLedgerEntry, type RewardType } from '../data/rewards';
import type { PortalCampaign, PortalRewardAssignment } from '../portal-client/types';
import type { BindLevel, PromoCodeClient } from '../promo-code-client';

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
  /** `[0, 1)`, same contract as `Math.random`. Injectable so the invented-fallback promo-code
   * selection is deterministic in tests. */
  readonly random?: () => number;
  /** The real promo-code-service caller. `null`/omitted means every `promo_code` reward uses the
   * invented fallback — the same behaviour this module had before this link existed. */
  readonly promoCodeClient?: PromoCodeClient | null;
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

function inventedPromoCode(random: () => number): string {
  const index = Math.min(
    Math.floor(random() * PROMO_CODE_DISCOUNTS.length),
    PROMO_CODE_DISCOUNTS.length - 1,
  );
  return `SAVE${PROMO_CODE_DISCOUNTS[index]}`;
}

/** Where in the campaign structure a reward assignment lives, in promo-code-service's own
 * `bindLevel`/`bindRefId` vocabulary — derived from the exact assignment {@link
 * pickRewardAssignment} already chose, never re-queried, so a generate call can only ever target
 * the one binding a maker actually attached. `refId` is `null` at campaign level (the assignment
 * schema's own contract), so that case falls back to the campaign's own id. */
function bindingFor(
  campaign: PortalCampaign,
  assignment: PortalRewardAssignment,
): { bindLevel: BindLevel; bindRefId: string } {
  if (assignment.level === 'campaign') {
    return { bindLevel: 'CAMPAIGN', bindRefId: String(campaign.id) };
  }
  const bindRefId = String(assignment.refId);
  return { bindLevel: assignment.level === 'tracker' ? 'TRACKER' : 'COMPONENT', bindRefId };
}

/**
 * The one call this module makes to a real, external service. Resolves to a real
 * promo-code-service `code` on success; falls back to an invented `SAVE##` string (never throws)
 * whenever there is nothing to call (`client`/`promoCodeConfigId` absent) or the call itself does
 * not produce a usable code — a customer's tracker completion must always mint *some* reward.
 */
async function resolvePromoCode(
  campaign: PortalCampaign,
  assignment: PortalRewardAssignment,
  customerId: string,
  client: PromoCodeClient | null,
  random: () => number,
): Promise<string> {
  if (!client || assignment.promoCodeConfigId === null) return inventedPromoCode(random);

  const { bindLevel, bindRefId } = bindingFor(campaign, assignment);
  try {
    const result = await client.generateCode({
      correlationId: randomUUID(),
      tenantId: String(campaign.tenantId),
      bindLevel,
      bindRefId,
      customerId,
    });
    if (result.status === 'SUCCESS' && result.code) return result.code;
    console.warn(
      `promo-code-service generate: ${result.status}${result.errorCode ? ` (${result.errorCode})` : ''} for ` +
        `tenant ${campaign.tenantId}, ${bindLevel} ${bindRefId} — falling back to an invented code`,
    );
  } catch (err) {
    console.warn(
      `promo-code-service generate call failed — falling back to an invented code: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return inventedPromoCode(random);
}

async function deriveValueAndCurrency(
  type: RewardType,
  campaign: PortalCampaign,
  assignment: PortalRewardAssignment,
  customerId: string,
  client: PromoCodeClient | null,
  random: () => number,
): Promise<{ value: string; currency: string | null }> {
  switch (type) {
    case 'cashback':
      // Real `amount` wins if a future seed ever populates it; invented fallback otherwise.
      return { value: assignment.amount ?? DEMO_CASHBACK_AMOUNT, currency: DEMO_CASHBACK_CURRENCY };
    case 'points':
      return { value: assignment.amount ?? DEMO_POINTS_AMOUNT, currency: null };
    case 'promo_code':
      return {
        value: await resolvePromoCode(campaign, assignment, customerId, client, random),
        currency: null,
      };
  }
}

/** Builds the ledger entry itself. `campaignId`/`campaignCode`/`type` are always real (traced back
 * to the real campaign + the real reward assignment's `unitType`); `expiresAt` reuses the
 * campaign's own real `endDate` (same choice `data/seed.ts` made for its one seeded reward);
 * `issuedAt` is the actual moment this fired, not an invented date. */
export async function buildRewardForCompletedTracker(
  customerId: string,
  campaign: PortalCampaign,
  assignment: PortalRewardAssignment,
  deps: RewardGenerationDeps = {},
): Promise<RewardLedgerEntry> {
  const now = deps.now ?? (() => new Date());
  const idGenerator = deps.idGenerator ?? randomUUID;
  const random = deps.random ?? Math.random;
  const promoCodeClient = deps.promoCodeClient ?? null;

  const type = rewardTypeFromUnitType(assignment.unitType);
  const { value, currency } = await deriveValueAndCurrency(
    type,
    campaign,
    assignment,
    customerId,
    promoCodeClient,
    random,
  );

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
