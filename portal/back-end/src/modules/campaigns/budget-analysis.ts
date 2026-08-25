/**
 * T-037 step 6 — the live sanity checks (implementation notes 15/16), the tenant-ceiling picture
 * (note 17) and the worst-case payout line (note 10).
 *
 * ### Pure functions, on purpose
 *
 * Nothing here touches the database, the request or the clock. Every input is passed in, which
 * is what makes the arithmetic — the part that decides whether a maker is warned about a budget
 * that will stop paying mid-month — exhaustively unit-testable without a fixture, and what lets
 * the same functions serve three callers that reach the data very differently:
 * `GET /campaigns/:id/caps` (live, as the maker types), `GET /campaigns/:id/review` (step 7) and
 * `POST /campaigns/:id/submit` (the enforcement point, which must not depend on either screen
 * having been rendered — TC-21kk).
 *
 * ### Warnings are warnings. There is exactly one hard stop.
 *
 * 11-BUDGETS-AND-LIMITS.md §4.4 is explicit that an over-allocated tracker budget is *"a normal
 * hedge"* and that blocking it *"would force makers to under-allocate"*; §3.1 says the same of an
 * intentionally uncapped reward. So every function below returns {@link CampaignWarning}s and
 * none of them throws. The only refusal in this whole area is
 * `BUDGET_EXCEEDS_TENANT_CEILING` at submit, and it lives in the service where the transaction
 * is — see `campaigns.service.ts#submit`.
 *
 * `BUDGET_ABOVE_TENANT_CEILING` appears here *as a warning* even though it will become a 422:
 * step 6 has to show the maker the red state while they are still typing, long before they press
 * submit. The warning and the error are computed from the same {@link ceilingStatuses} output,
 * so the screen and the service can never disagree about which side of the line a budget is on.
 */
import type {
  BudgetCeilingStatus,
  CampaignCapRow,
  CampaignWarning,
  WorstCasePayoutLine,
} from '@reward-portal/shared';
import { daysBetween, format, multiplyByInteger, parse, percentOf, sum } from './decimal.util';

/** A tenant ceiling row, reduced to what the arithmetic needs. */
export interface CeilingRow {
  readonly unitType: string;
  readonly unitCode: string;
  readonly maxCampaignBudget: string;
  readonly warnAboveAmount: string | null;
}

/** One reward attachment, reduced to what the arithmetic needs. */
export interface RewardUnit {
  readonly unitType: string | null;
  readonly unitCode: string | null;
  readonly amount: string | null;
}

export interface BudgetAnalysisInput {
  readonly caps: readonly CampaignCapRow[];
  readonly ceilings: readonly CeilingRow[];
  readonly rewards: readonly RewardUnit[];
  /** `tenant_campaigns.budget_currency`, when the maker set one in step 1. */
  readonly campaignCurrency: string | null;
  readonly startDate: Date;
  readonly endDate: Date;
}

/** A unit is a `(type, code)` pair. There is no conversion rate anywhere (§3.1), so this string
 * is the only thing two amounts must share before they may be compared or added. */
function unitKey(unitType: string | null, unitCode: string | null): string | null {
  if (unitType === null || unitCode === null) return null;
  return `${unitType}:${unitCode}`;
}

function splitUnitKey(key: string): { unitType: string; unitCode: string } {
  const index = key.indexOf(':');
  return { unitType: key.slice(0, index), unitCode: key.slice(index + 1) };
}

/**
 * The campaign's **lifetime budget per unit** — the figure the tenant ceiling constrains
 * (11-BUDGETS-AND-LIMITS.md §8.2: *"no single campaign may declare a lifetime budget above
 * this"*).
 *
 * Campaign-scope lifetime budgets only: a daily budget is not a lifetime commitment, and a
 * tracker budget is a subdivision of the campaign's, so counting either toward the ceiling would
 * refuse campaigns that are nowhere near it.
 */
export function lifetimeBudgetsByUnit(caps: readonly CampaignCapRow[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const cap of caps) {
    if (cap.capClass !== 'budget') continue;
    if (cap.scopeLevel !== 'campaign' || cap.periodType !== 'lifetime') continue;
    const key = unitKey(cap.unitType, cap.unitCode);
    if (key === null) continue;
    const amount = parse(cap.maxTotalAmount);
    if (amount === null) continue;
    totals.set(key, (totals.get(key) ?? 0n) + amount);
  }
  return totals;
}

/**
 * The per-unit ceiling picture (implementation note 17), for every unit that has a budget **or**
 * a ceiling.
 *
 * A unit with a ceiling but no budget is included deliberately: showing the maker "MYR: 0 of
 * 500,000 (unlimited headroom)" is how they learn a ceiling exists at all before they type a
 * number into it.
 *
 * `state: 'unlimited'` is 11-BUDGETS-AND-LIMITS.md §8.5's chosen option — *"no ceiling row for
 * that tenant/unit means unlimited, not blocked"*. TC-21ii depends on it, and so does every
 * tenant on the day this ships.
 */
export function ceilingStatuses(
  caps: readonly CampaignCapRow[],
  ceilings: readonly CeilingRow[],
): readonly BudgetCeilingStatus[] {
  const budgets = lifetimeBudgetsByUnit(caps);
  const ceilingsByUnit = new Map<string, CeilingRow>();
  for (const ceiling of ceilings) {
    const key = unitKey(ceiling.unitType, ceiling.unitCode);
    if (key !== null) ceilingsByUnit.set(key, ceiling);
  }

  const keys = new Set<string>([...budgets.keys(), ...ceilingsByUnit.keys()]);
  const statuses: BudgetCeilingStatus[] = [];

  for (const key of [...keys].sort()) {
    const { unitType, unitCode } = splitUnitKey(key);
    const budget = budgets.get(key) ?? 0n;
    const ceiling = ceilingsByUnit.get(key);
    const max = ceiling === undefined ? null : parse(ceiling.maxCampaignBudget);
    const warnAbove =
      ceiling?.warnAboveAmount === undefined ? null : parse(ceiling.warnAboveAmount);

    let state: BudgetCeilingStatus['state'];
    if (max === null) state = 'unlimited';
    else if (budget > max) state = 'over';
    else if (warnAbove !== null && budget > warnAbove) state = 'warn';
    else state = 'ok';

    statuses.push({
      unitType,
      unitCode,
      campaignBudget: format(budget),
      maxCampaignBudget: max === null ? null : format(max),
      warnAboveAmount: warnAbove === null ? null : format(warnAbove),
      headroom: max === null ? null : format(max - budget),
      percentOfCeiling: max === null ? null : percentOf(budget, max),
      state,
    });
  }

  return statuses;
}

/** Which units' budgets exceed their tenant ceiling. The submit gate's input — see
 * `campaigns.service.ts#submit` and TC-21ff/TC-21kk. Empty for TC-21ii (no ceiling row) and for
 * TC-21jj (an MYR ceiling never constrains a PTS budget, because their unit keys differ). */
export function ceilingBreaches(
  statuses: readonly BudgetCeilingStatus[],
): readonly { unitType: string; unitCode: string }[] {
  return statuses
    .filter((status) => status.state === 'over')
    .map((status) => ({ unitType: status.unitType, unitCode: status.unitCode }));
}

/**
 * Every step-6 warning (implementation notes 15/16/17), in a stable order.
 *
 * Each block below is one bullet of note 15 or note 16, and each is annotated with the failure
 * it exists to make visible — because in six months the question about any of them will be
 * "why does this fire?", not "what does this compute?".
 */
export function analyseBudgets(input: BudgetAnalysisInput): readonly CampaignWarning[] {
  const warnings: CampaignWarning[] = [];

  warnings.push(...trackerOverAllocationWarnings(input.caps));
  warnings.push(...customerLimitAboveDailyBudgetWarnings(input.caps));
  warnings.push(...unreachableCustomerLimitWarnings(input.caps, input.startDate, input.endDate));
  warnings.push(...unbudgetedRewardWarnings(input.caps, input.rewards));
  warnings.push(...currencyMismatchWarnings(input.caps, input.campaignCurrency));
  warnings.push(...ceilingWarnings(ceilingStatuses(input.caps, [])));

  return warnings;
}

/**
 * {@link analyseBudgets} plus the ceiling warnings, which need the tenant's ceiling rows and so
 * cannot be computed from the caps alone. Split out rather than folded in so a caller that has
 * not loaded ceilings still gets every other check.
 */
export function analyseBudgetsWithCeilings(input: BudgetAnalysisInput): {
  warnings: readonly CampaignWarning[];
  ceilings: readonly BudgetCeilingStatus[];
} {
  const statuses = ceilingStatuses(input.caps, input.ceilings);
  const warnings: CampaignWarning[] = [
    ...trackerOverAllocationWarnings(input.caps),
    ...customerLimitAboveDailyBudgetWarnings(input.caps),
    ...unreachableCustomerLimitWarnings(input.caps, input.startDate, input.endDate),
    ...unbudgetedRewardWarnings(input.caps, input.rewards),
    ...currencyMismatchWarnings(input.caps, input.campaignCurrency),
    ...ceilingWarnings(statuses),
  ];
  return { warnings, ceilings: statuses };
}

/**
 * Note 15, first bullet / TC-21x — *"tracker budgets summing above the campaign budget — allowed
 * (not every tracker is consumed) but shown, because silently over-allocating is how a campaign
 * stops paying mid-month with nobody understanding why"*.
 *
 * Compared per unit and per period type: a tracker's **daily** budget belongs against the
 * campaign's **daily** budget, not its lifetime one. Comparing across periods would fire on
 * every campaign that has both.
 */
function trackerOverAllocationWarnings(caps: readonly CampaignCapRow[]): CampaignWarning[] {
  const campaignBudgets = new Map<string, bigint>();
  const trackerBudgets = new Map<string, bigint>();

  for (const cap of caps) {
    if (cap.capClass !== 'budget') continue;
    const unit = unitKey(cap.unitType, cap.unitCode);
    if (unit === null) continue;
    const amount = parse(cap.maxTotalAmount);
    if (amount === null) continue;
    const key = `${unit}|${cap.periodType}`;

    if (cap.scopeLevel === 'campaign') {
      campaignBudgets.set(key, (campaignBudgets.get(key) ?? 0n) + amount);
    } else if (cap.scopeLevel === 'tracker') {
      trackerBudgets.set(key, (trackerBudgets.get(key) ?? 0n) + amount);
    }
  }

  const warnings: CampaignWarning[] = [];
  for (const [key, trackerTotal] of [...trackerBudgets.entries()].sort()) {
    const campaignTotal = campaignBudgets.get(key);
    // No campaign-level budget for this unit/period is not over-allocation — it is an uncapped
    // campaign with capped trackers, which is a different (legitimate) shape.
    if (campaignTotal === undefined || trackerTotal <= campaignTotal) continue;
    const [unit, periodType] = key.split('|');
    const { unitType, unitCode } = splitUnitKey(unit);
    warnings.push({
      code: 'TRACKER_BUDGETS_EXCEED_CAMPAIGN',
      unitType,
      unitCode,
      detail: {
        periodType,
        trackerTotal: format(trackerTotal),
        campaignBudget: format(campaignTotal),
      },
    });
  }
  return warnings;
}

/**
 * Note 15, second bullet / TC-21y — *"a per-customer daily limit exceeding the campaign daily
 * budget — the budget will stop the first customer"*.
 */
function customerLimitAboveDailyBudgetWarnings(caps: readonly CampaignCapRow[]): CampaignWarning[] {
  const dailyBudgets = new Map<string, bigint>();
  for (const cap of caps) {
    if (cap.capClass !== 'budget' || cap.scopeLevel !== 'campaign' || cap.periodType !== 'daily') {
      continue;
    }
    const unit = unitKey(cap.unitType, cap.unitCode);
    const amount = parse(cap.maxTotalAmount);
    if (unit === null || amount === null) continue;
    dailyBudgets.set(unit, (dailyBudgets.get(unit) ?? 0n) + amount);
  }

  const warnings: CampaignWarning[] = [];
  for (const cap of caps) {
    if (cap.capClass !== 'limit' || cap.periodType !== 'daily') continue;
    const unit = unitKey(cap.unitType, cap.unitCode);
    const amount = parse(cap.maxTotalAmount);
    if (unit === null || amount === null) continue;
    const budget = dailyBudgets.get(unit);
    if (budget === undefined || amount <= budget) continue;
    const { unitType, unitCode } = splitUnitKey(unit);
    warnings.push({
      code: 'CUSTOMER_LIMIT_EXCEEDS_DAILY_BUDGET',
      unitType,
      unitCode,
      detail: { customerDailyLimit: format(amount), campaignDailyBudget: format(budget) },
    });
  }
  return warnings;
}

/**
 * Note 15, third bullet — *"a per-customer campaign limit unreachable given daily limit x
 * campaign days"*.
 *
 * A limit nobody can reach is not harmful, but it is always a mistake: the maker believes they
 * have allowed MYR 1,000 per customer and have actually allowed MYR 50 x 5 days = MYR 250.
 */
function unreachableCustomerLimitWarnings(
  caps: readonly CampaignCapRow[],
  startDate: Date,
  endDate: Date,
): CampaignWarning[] {
  const days = daysBetween(startDate, endDate);
  const dailyLimits = new Map<string, bigint>();
  for (const cap of caps) {
    if (cap.capClass !== 'limit' || cap.periodType !== 'daily') continue;
    const unit = unitKey(cap.unitType, cap.unitCode);
    const amount = parse(cap.maxTotalAmount);
    if (unit === null || amount === null) continue;
    // The tightest daily limit is the binding one when several exist for a unit.
    const existing = dailyLimits.get(unit);
    dailyLimits.set(unit, existing === undefined || amount < existing ? amount : existing);
  }

  const warnings: CampaignWarning[] = [];
  for (const cap of caps) {
    if (cap.capClass !== 'limit' || cap.periodType !== 'lifetime') continue;
    const unit = unitKey(cap.unitType, cap.unitCode);
    const lifetime = parse(cap.maxTotalAmount);
    if (unit === null || lifetime === null) continue;
    const daily = dailyLimits.get(unit);
    if (daily === undefined) continue;
    const reachable = multiplyByInteger(daily, days);
    if (reachable >= lifetime) continue;
    const { unitType, unitCode } = splitUnitKey(unit);
    warnings.push({
      code: 'CUSTOMER_CAMPAIGN_LIMIT_UNREACHABLE',
      unitType,
      unitCode,
      detail: {
        campaignLimit: format(lifetime),
        dailyLimit: format(daily),
        campaignDays: days,
        maximumReachable: format(reachable),
      },
    });
  }
  return warnings;
}

/**
 * Note 16 / TC-21dd — *"if a campaign attaches a reward whose unit has no matching budget, step 6
 * warns 'Your points reward (PTS) has no budget — it will be uncapped.'"*
 *
 * A warning, not a block: *"an intentionally uncapped reward is legitimate, but it must never
 * happen silently, since the entire point of this decision was to avoid budgets that cannot be
 * enforced"* (11-BUDGETS-AND-LIMITS.md §3.1). TC-21ee is the negative case — a cash reward with
 * an MYR budget present produces nothing.
 */
function unbudgetedRewardWarnings(
  caps: readonly CampaignCapRow[],
  rewards: readonly RewardUnit[],
): CampaignWarning[] {
  const budgetedUnits = new Set<string>();
  for (const cap of caps) {
    if (cap.capClass !== 'budget') continue;
    const unit = unitKey(cap.unitType, cap.unitCode);
    if (unit !== null) budgetedUnits.add(unit);
  }

  const seen = new Set<string>();
  const warnings: CampaignWarning[] = [];
  for (const reward of rewards) {
    const unit = unitKey(reward.unitType, reward.unitCode);
    // A reward whose version declares no unit cannot be matched to a budget in either direction;
    // warning about it would be noise the maker cannot act on from this screen.
    if (unit === null || budgetedUnits.has(unit) || seen.has(unit)) continue;
    seen.add(unit);
    const { unitType, unitCode } = splitUnitKey(unit);
    warnings.push({
      code: 'REWARD_UNIT_HAS_NO_BUDGET',
      unitType,
      unitCode,
      detail: {},
    });
  }
  return warnings;
}

/** TC-21bb — a cap denominated in a currency other than the campaign's own. Surfaced as a
 * warning here (step 6, live) and refused at write time unless `confirmCurrencyMismatch` is set
 * (`caps.service.ts`), which is what "requires explicit confirmation" means. */
function currencyMismatchWarnings(
  caps: readonly CampaignCapRow[],
  campaignCurrency: string | null,
): CampaignWarning[] {
  if (campaignCurrency === null) return [];
  const seen = new Set<string>();
  const warnings: CampaignWarning[] = [];
  for (const cap of caps) {
    if (cap.unitType !== 'currency' || cap.unitCode === null) continue;
    if (cap.unitCode === campaignCurrency || seen.has(cap.unitCode)) continue;
    seen.add(cap.unitCode);
    warnings.push({
      code: 'CAP_CURRENCY_DIFFERS_FROM_CAMPAIGN',
      unitType: 'currency',
      unitCode: cap.unitCode,
      detail: { campaignCurrency },
    });
  }
  return warnings;
}

/** Note 17 — the amber and red notices, derived from the same statuses the submit gate reads. */
function ceilingWarnings(statuses: readonly BudgetCeilingStatus[]): CampaignWarning[] {
  const warnings: CampaignWarning[] = [];
  for (const status of statuses) {
    if (status.state === 'warn') {
      warnings.push({
        code: 'BUDGET_NEAR_TENANT_CEILING',
        unitType: status.unitType,
        unitCode: status.unitCode,
        detail: {
          percentOfCeiling: status.percentOfCeiling,
          maxCampaignBudget: status.maxCampaignBudget,
          headroom: status.headroom,
        },
      });
    } else if (status.state === 'over') {
      warnings.push({
        code: 'BUDGET_ABOVE_TENANT_CEILING',
        unitType: status.unitType,
        unitCode: status.unitCode,
        detail: {
          percentOfCeiling: status.percentOfCeiling,
          maxCampaignBudget: status.maxCampaignBudget,
        },
      });
    }
  }
  return warnings;
}

/**
 * The worst-case payout line (implementation note 10, TC-21n) — *"three stacking levels are easy
 * to misjudge"*.
 *
 * "Worst case" is one customer completing **everything**: every component reward, every tracker
 * reward and the campaign reward all pay. The sum is therefore over every attachment, per unit,
 * with no attempt to add across units (§3.1 — there is no conversion rate).
 *
 * `hasUnknownAmounts` is the honest part. A reward policy's payout lives in
 * `reward_policies.config`, free-form JSON this portal does not own the shape of; when no amount
 * can be read from it the total is a **floor**, not a total, and saying so is better than
 * printing a confident number that is wrong. Step 5 renders it as "at least X".
 */
export function worstCasePayout(rewards: readonly RewardUnit[]): readonly WorstCasePayoutLine[] {
  const byUnit = new Map<string, { total: bigint; count: number; unknown: boolean }>();

  for (const reward of rewards) {
    const key = unitKey(reward.unitType, reward.unitCode) ?? ' :unknown';
    const entry = byUnit.get(key) ?? { total: 0n, count: 0, unknown: false };
    const amount = parse(reward.amount);
    if (amount === null) entry.unknown = true;
    else entry.total += amount;
    entry.count += 1;
    byUnit.set(key, entry);
  }

  return [...byUnit.entries()].sort().map(([key, entry]) => {
    const known = key !== ' :unknown';
    const { unitType, unitCode } = known
      ? splitUnitKey(key)
      : { unitType: null as unknown as string, unitCode: null as unknown as string };
    return {
      unitType: known ? unitType : null,
      unitCode: known ? unitCode : null,
      perCustomerAmount: format(entry.total),
      attachmentCount: entry.count,
      hasUnknownAmounts: entry.unknown,
    };
  });
}

/** Re-exported so `caps.service.ts` can total a set of amounts without importing two modules. */
export { sum as sumAmounts };
