/**
 * T-037 step 6 — the live sanity checks (implementation notes 15/16), the tenant-ceiling picture
 * (note 17) and the worst-case payout (note 10).
 *
 * Every case here maps to a numbered test case in the task file. They are unit tests rather than
 * e2e ones because the arithmetic is the interesting part and a fixture campaign per boundary
 * condition would be an enormous amount of setup to assert one number.
 */
import {
  analyseBudgetsWithCeilings,
  ceilingBreaches,
  ceilingStatuses,
  lifetimeBudgetsByUnit,
  worstCasePayout,
  type CeilingRow,
  type RewardUnit,
} from '@/modules/campaigns/budget-analysis';
import { format } from '@/modules/campaigns/decimal.util';
import type { CampaignCapRow } from '@reward-portal/shared';

const START = new Date('2026-09-01T00:00:00Z');
const END = new Date('2026-09-11T00:00:00Z'); // 10 days

function cap(overrides: Partial<CampaignCapRow>): CampaignCapRow {
  return {
    id: 1,
    capClass: 'budget',
    scopeLevel: 'campaign',
    scopeRefId: null,
    periodType: 'lifetime',
    periodValue: null,
    windowStartTime: null,
    windowEndTime: null,
    periodTimezone: null,
    unitType: 'currency',
    unitCode: 'MYR',
    rewardType: null,
    maxTotalAmount: '1000',
    maxOccurrences: null,
    maxCustomers: null,
    onBreach: 'reject',
    warnAtPercent: null,
    status: 'active',
    ...overrides,
  };
}

function analyse(input: {
  caps?: CampaignCapRow[];
  ceilings?: CeilingRow[];
  rewards?: RewardUnit[];
  campaignCurrency?: string | null;
}) {
  return analyseBudgetsWithCeilings({
    caps: input.caps ?? [],
    ceilings: input.ceilings ?? [],
    rewards: input.rewards ?? [],
    // `in`, not `??`: `campaignCurrency: null` is a distinct case (a campaign with no currency of
    // its own) and must not be coalesced into the default.
    campaignCurrency:
      'campaignCurrency' in input ? (input.campaignCurrency as string | null) : 'MYR',
    startDate: START,
    endDate: END,
  });
}

function codes(warnings: readonly { code: string }[]): string[] {
  return warnings.map((warning) => warning.code);
}

describe('T-037 budget analysis', () => {
  describe('lifetimeBudgetsByUnit', () => {
    it('counts only campaign-scope lifetime budgets — §8.2 is about the declared lifetime figure', () => {
      const totals = lifetimeBudgetsByUnit([
        cap({ id: 1, maxTotalAmount: '500000' }),
        cap({ id: 2, periodType: 'daily', maxTotalAmount: '20000' }),
        cap({ id: 3, scopeLevel: 'tracker', scopeRefId: 7, maxTotalAmount: '50000' }),
        cap({ id: 4, capClass: 'limit', maxTotalAmount: '1000' }),
      ]);
      expect(totals.size).toBe(1);
      expect(format(totals.get('currency:MYR') as bigint)).toBe('500000');
    });

    it('keeps units apart — §3.1, no conversion rate exists', () => {
      const totals = lifetimeBudgetsByUnit([
        cap({ id: 1, maxTotalAmount: '500000' }),
        cap({ id: 2, unitType: 'points', unitCode: 'PTS', maxTotalAmount: '2000000' }),
      ]);
      expect(format(totals.get('currency:MYR') as bigint)).toBe('500000');
      expect(format(totals.get('points:PTS') as bigint)).toBe('2000000');
    });

    it('ignores a cap with no unit, which cannot be matched to a ceiling in either direction', () => {
      expect(
        lifetimeBudgetsByUnit([
          cap({ unitType: null, unitCode: null, maxTotalAmount: null, maxOccurrences: 3 }),
        ]).size,
      ).toBe(0);
    });
  });

  describe('ceilingStatuses — implementation note 17', () => {
    it('TC-21ii: a tenant with no ceiling row is unlimited, not blocked', () => {
      const [status] = ceilingStatuses([cap({ maxTotalAmount: '5000000' })], []);
      expect(status.state).toBe('unlimited');
      expect(status.maxCampaignBudget).toBeNull();
      expect(status.headroom).toBeNull();
      expect(status.percentOfCeiling).toBeNull();
      expect(ceilingBreaches([status])).toEqual([]);
    });

    it('reports headroom and percentage below the warn threshold', () => {
      const [status] = ceilingStatuses(
        [cap({ maxTotalAmount: '100000' })],
        [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            maxCampaignBudget: '500000',
            warnAboveAmount: '400000',
          },
        ],
      );
      expect(status.state).toBe('ok');
      expect(status.headroom).toBe('400000');
      expect(status.percentOfCeiling).toBe(20);
    });

    it('TC-21hh: between warn_above_amount and the ceiling is amber, and carries the percentage', () => {
      const [status] = ceilingStatuses(
        [cap({ maxTotalAmount: '470000' })],
        [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            maxCampaignBudget: '500000',
            warnAboveAmount: '400000',
          },
        ],
      );
      expect(status.state).toBe('warn');
      expect(status.percentOfCeiling).toBe(94);
      expect(ceilingBreaches([status])).toEqual([]);
    });

    it('TC-21ff: above max_campaign_budget is over, and is what the submit gate reads', () => {
      const statuses = ceilingStatuses(
        [cap({ maxTotalAmount: '500001' })],
        [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            maxCampaignBudget: '500000',
            warnAboveAmount: null,
          },
        ],
      );
      expect(statuses[0].state).toBe('over');
      expect(ceilingBreaches(statuses)).toEqual([{ unitType: 'currency', unitCode: 'MYR' }]);
    });

    it('exactly at the ceiling is allowed — the constraint is "above", not "at"', () => {
      const statuses = ceilingStatuses(
        [cap({ maxTotalAmount: '500000' })],
        [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            maxCampaignBudget: '500000',
            warnAboveAmount: null,
          },
        ],
      );
      expect(statuses[0].state).toBe('ok');
      expect(ceilingBreaches(statuses)).toEqual([]);
    });

    it('TC-21jj: an MYR ceiling does not constrain a PTS budget', () => {
      const statuses = ceilingStatuses(
        [cap({ unitType: 'points', unitCode: 'PTS', maxTotalAmount: '9999999' })],
        [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            maxCampaignBudget: '100',
            warnAboveAmount: null,
          },
        ],
      );
      expect(ceilingBreaches(statuses)).toEqual([]);
      // Both units are still reported, so the maker sees the MYR ceiling exists.
      expect(statuses.map((status) => `${status.unitCode}:${status.state}`).sort()).toEqual([
        'MYR:ok',
        'PTS:unlimited',
      ]);
    });

    it('shows a unit that has a ceiling but no budget yet, so the ceiling is discoverable', () => {
      const [status] = ceilingStatuses(
        [],
        [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            maxCampaignBudget: '500000',
            warnAboveAmount: null,
          },
        ],
      );
      expect(status.campaignBudget).toBe('0');
      expect(status.headroom).toBe('500000');
      expect(status.state).toBe('ok');
    });

    it('ignores a ceiling row whose amount is unparseable rather than blocking on it', () => {
      const [status] = ceilingStatuses(
        [cap({ maxTotalAmount: '1' })],
        [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            maxCampaignBudget: 'nonsense',
            warnAboveAmount: null,
          },
        ],
      );
      expect(status.state).toBe('unlimited');
    });
  });

  describe('note 15 — the three live sanity checks', () => {
    it('TC-21x: tracker budgets above the campaign budget warn but never block', () => {
      const { warnings } = analyse({
        caps: [
          cap({ id: 1, maxTotalAmount: '100000' }),
          cap({ id: 2, scopeLevel: 'tracker', scopeRefId: 7, maxTotalAmount: '90000' }),
          cap({ id: 3, scopeLevel: 'tracker', scopeRefId: 8, maxTotalAmount: '60000' }),
        ],
      });
      const warning = warnings.find((entry) => entry.code === 'TRACKER_BUDGETS_EXCEED_CAMPAIGN');
      expect(warning).toBeDefined();
      expect(warning?.detail).toMatchObject({ trackerTotal: '150000', campaignBudget: '100000' });
    });

    it('compares tracker budgets against the campaign budget of the same period, not across periods', () => {
      const { warnings } = analyse({
        caps: [
          cap({ id: 1, periodType: 'lifetime', maxTotalAmount: '100000' }),
          cap({
            id: 2,
            scopeLevel: 'tracker',
            scopeRefId: 7,
            periodType: 'daily',
            maxTotalAmount: '2000',
          }),
        ],
      });
      expect(codes(warnings)).not.toContain('TRACKER_BUDGETS_EXCEED_CAMPAIGN');
    });

    it('does not warn when there is no campaign budget for that unit — capped trackers under an uncapped campaign are legitimate', () => {
      const { warnings } = analyse({
        caps: [cap({ scopeLevel: 'tracker', scopeRefId: 7, maxTotalAmount: '90000' })],
      });
      expect(codes(warnings)).not.toContain('TRACKER_BUDGETS_EXCEED_CAMPAIGN');
    });

    it('TC-21y: a per-customer daily limit above the campaign daily budget warns', () => {
      const { warnings } = analyse({
        caps: [
          cap({ id: 1, periodType: 'daily', maxTotalAmount: '100' }),
          cap({ id: 2, capClass: 'limit', periodType: 'daily', maxTotalAmount: '500' }),
        ],
      });
      const warning = warnings.find(
        (entry) => entry.code === 'CUSTOMER_LIMIT_EXCEEDS_DAILY_BUDGET',
      );
      expect(warning?.detail).toMatchObject({
        customerDailyLimit: '500',
        campaignDailyBudget: '100',
      });
    });

    it('an unreachable per-customer campaign limit warns with the arithmetic that makes it unreachable', () => {
      const { warnings } = analyse({
        caps: [
          cap({ id: 1, capClass: 'limit', periodType: 'daily', maxTotalAmount: '50' }),
          cap({ id: 2, capClass: 'limit', periodType: 'lifetime', maxTotalAmount: '1000' }),
        ],
      });
      const warning = warnings.find(
        (entry) => entry.code === 'CUSTOMER_CAMPAIGN_LIMIT_UNREACHABLE',
      );
      // 50 x 10 days = 500, short of the 1,000 the maker believes they allowed.
      expect(warning?.detail).toMatchObject({
        campaignLimit: '1000',
        dailyLimit: '50',
        campaignDays: 10,
        maximumReachable: '500',
      });
    });

    it('does not warn when the daily limit does reach the campaign limit', () => {
      const { warnings } = analyse({
        caps: [
          cap({ id: 1, capClass: 'limit', periodType: 'daily', maxTotalAmount: '200' }),
          cap({ id: 2, capClass: 'limit', periodType: 'lifetime', maxTotalAmount: '1000' }),
        ],
      });
      expect(codes(warnings)).not.toContain('CUSTOMER_CAMPAIGN_LIMIT_UNREACHABLE');
    });

    it('uses the tightest daily limit when several exist for one unit', () => {
      const { warnings } = analyse({
        caps: [
          cap({ id: 1, capClass: 'limit', periodType: 'daily', maxTotalAmount: '200' }),
          cap({
            id: 2,
            capClass: 'limit',
            periodType: 'daily',
            scopeLevel: 'tracker',
            scopeRefId: 4,
            maxTotalAmount: '20',
          }),
          cap({ id: 3, capClass: 'limit', periodType: 'lifetime', maxTotalAmount: '1000' }),
        ],
      });
      const warning = warnings.find(
        (entry) => entry.code === 'CUSTOMER_CAMPAIGN_LIMIT_UNREACHABLE',
      );
      expect(warning?.detail).toMatchObject({ dailyLimit: '20', maximumReachable: '200' });
    });
  });

  describe('note 16 — one budget per reward unit', () => {
    it('TC-21dd: a points reward with no PTS budget warns, and submission is still allowed', () => {
      const { warnings } = analyse({
        caps: [cap({ maxTotalAmount: '500000' })],
        rewards: [{ unitType: 'points', unitCode: 'PTS', amount: '100' }],
      });
      const warning = warnings.find((entry) => entry.code === 'REWARD_UNIT_HAS_NO_BUDGET');
      expect(warning).toMatchObject({ unitType: 'points', unitCode: 'PTS' });
    });

    it('TC-21ee: a cash reward with an MYR budget present produces no warning', () => {
      const { warnings } = analyse({
        caps: [cap({ maxTotalAmount: '500000' })],
        rewards: [{ unitType: 'currency', unitCode: 'MYR', amount: '10' }],
      });
      expect(codes(warnings)).not.toContain('REWARD_UNIT_HAS_NO_BUDGET');
    });

    it('warns once per unit, not once per attachment', () => {
      const { warnings } = analyse({
        rewards: [
          { unitType: 'points', unitCode: 'PTS', amount: '100' },
          { unitType: 'points', unitCode: 'PTS', amount: '200' },
        ],
      });
      expect(codes(warnings).filter((code) => code === 'REWARD_UNIT_HAS_NO_BUDGET')).toHaveLength(
        1,
      );
    });

    it('says nothing about a reward whose version declares no unit — the maker cannot act on it here', () => {
      const { warnings } = analyse({ rewards: [{ unitType: null, unitCode: null, amount: '5' }] });
      expect(codes(warnings)).not.toContain('REWARD_UNIT_HAS_NO_BUDGET');
    });
  });

  describe('TC-21bb — a cap currency other than the campaign currency', () => {
    it('warns, naming the campaign currency it differs from', () => {
      const { warnings } = analyse({
        caps: [cap({ unitCode: 'SGD' })],
        campaignCurrency: 'MYR',
      });
      const warning = warnings.find((entry) => entry.code === 'CAP_CURRENCY_DIFFERS_FROM_CAMPAIGN');
      expect(warning?.detail).toMatchObject({ campaignCurrency: 'MYR' });
    });

    it('says nothing when the campaign has no currency of its own to differ from', () => {
      const { warnings } = analyse({ caps: [cap({ unitCode: 'SGD' })], campaignCurrency: null });
      expect(codes(warnings)).not.toContain('CAP_CURRENCY_DIFFERS_FROM_CAMPAIGN');
    });

    it('ignores non-currency units — points are not a currency and cannot mismatch one', () => {
      const { warnings } = analyse({
        caps: [cap({ unitType: 'points', unitCode: 'PTS' })],
        campaignCurrency: 'MYR',
      });
      expect(codes(warnings)).not.toContain('CAP_CURRENCY_DIFFERS_FROM_CAMPAIGN');
    });
  });

  describe('note 17 — the ceiling warnings the screen shows', () => {
    it('emits the amber notice with its percentage', () => {
      const { warnings } = analyse({
        caps: [cap({ maxTotalAmount: '470000' })],
        ceilings: [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            maxCampaignBudget: '500000',
            warnAboveAmount: '400000',
          },
        ],
      });
      const warning = warnings.find((entry) => entry.code === 'BUDGET_NEAR_TENANT_CEILING');
      expect(warning?.detail).toMatchObject({ percentOfCeiling: 94, headroom: '30000' });
    });

    it('emits the red notice, which the submit gate turns into a 422', () => {
      const { warnings, ceilings } = analyse({
        caps: [cap({ maxTotalAmount: '600000' })],
        ceilings: [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            maxCampaignBudget: '500000',
            warnAboveAmount: null,
          },
        ],
      });
      expect(codes(warnings)).toContain('BUDGET_ABOVE_TENANT_CEILING');
      expect(ceilingBreaches(ceilings)).toHaveLength(1);
    });
  });

  describe('worstCasePayout — implementation note 10', () => {
    it('TC-21n: sums every attachment per unit, keeping units apart', () => {
      const lines = worstCasePayout([
        { unitType: 'currency', unitCode: 'MYR', amount: '5' },
        { unitType: 'currency', unitCode: 'MYR', amount: '10.50' },
        { unitType: 'points', unitCode: 'PTS', amount: '200' },
      ]);
      expect(lines).toEqual([
        {
          unitType: 'currency',
          unitCode: 'MYR',
          perCustomerAmount: '15.5',
          attachmentCount: 2,
          hasUnknownAmounts: false,
        },
        {
          unitType: 'points',
          unitCode: 'PTS',
          perCustomerAmount: '200',
          attachmentCount: 1,
          hasUnknownAmounts: false,
        },
      ]);
    });

    it('flags a floor rather than a total when a policy exposes no amount', () => {
      const [line] = worstCasePayout([
        { unitType: 'currency', unitCode: 'MYR', amount: '5' },
        { unitType: 'currency', unitCode: 'MYR', amount: null },
      ]);
      expect(line.perCustomerAmount).toBe('5');
      expect(line.attachmentCount).toBe(2);
      expect(line.hasUnknownAmounts).toBe(true);
    });

    it('groups attachments with no unit together rather than dropping them', () => {
      const [line] = worstCasePayout([{ unitType: null, unitCode: null, amount: '5' }]);
      expect(line.unitType).toBeNull();
      expect(line.unitCode).toBeNull();
      expect(line.attachmentCount).toBe(1);
    });

    it('is empty when nothing is attached', () => {
      expect(worstCasePayout([])).toEqual([]);
    });
  });
});
