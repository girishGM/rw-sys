/**
 * T-RTS-030 — `shapeRewardGroup`, the one function AGENT-PROTOCOL.md R4 depends on.
 *
 * Every assertion here checks the *observable* property the rule is actually about — key presence
 * — via `Object.prototype.hasOwnProperty`, never just "the value looks right", since a test that only
 * checks a value could pass even if the key were wrongly present as `undefined`/`null` (see
 * AGENT-PROTOCOL.md §3's "assert the observable property" rule).
 */
import {
  isSummableRewardKind,
  shapeRewardGroup,
  SUMMABLE_REWARD_KINDS,
  type NonSummableRewardGroup,
  type RewardGroupInput,
  type SummableRewardGroup,
} from '@/modules/api/reward-kind-response-shaper';

function hasKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

describe('T-RTS-030 — reward-kind-response-shaper', () => {
  describe('isSummableRewardKind / SUMMABLE_REWARD_KINDS', () => {
    it('is exactly FIXED_AMOUNT and POINTS', () => {
      expect([...SUMMABLE_REWARD_KINDS].sort()).toEqual(['FIXED_AMOUNT', 'POINTS']);
    });

    it('returns false for null', () => {
      expect(isSummableRewardKind(null)).toBe(false);
    });

    it.each(['PERCENTAGE', 'PHYSICAL', 'PROMO_CODE'] as const)('returns false for %s', (kind) => {
      expect(isSummableRewardKind(kind)).toBe(false);
    });

    it.each(['FIXED_AMOUNT', 'POINTS'] as const)('returns true for %s', (kind) => {
      expect(isSummableRewardKind(kind)).toBe(true);
    });
  });

  describe('shapeRewardGroup', () => {
    it('TC-1 (FIXED_AMOUNT component): emits totalValue, totalCount, unitType, unitCode', () => {
      const input: RewardGroupInput = {
        rewardCategory: 'CASHBACK',
        rewardKind: 'FIXED_AMOUNT',
        unitType: 'currency',
        unitCode: 'MYR',
        totalValue: '5.0000',
        totalCount: 2,
      };
      const shaped = shapeRewardGroup(input) as SummableRewardGroup;
      expect(shaped).toEqual({
        rewardCategory: 'CASHBACK',
        rewardKind: 'FIXED_AMOUNT',
        unitType: 'currency',
        unitCode: 'MYR',
        totalValue: '5.0000',
        totalCount: 2,
      });
      expect(hasKey(shaped, 'totalValue')).toBe(true);
    });

    it('POINTS component: unitCode may be null but is still present (not omitted)', () => {
      const shaped = shapeRewardGroup({
        rewardCategory: 'POINTS',
        rewardKind: 'POINTS',
        unitType: 'points',
        unitCode: null,
        totalValue: '100',
        totalCount: 1,
      }) as SummableRewardGroup;
      expect(hasKey(shaped, 'unitCode')).toBe(true);
      expect(shaped.unitCode).toBeNull();
      expect(hasKey(shaped, 'totalValue')).toBe(true);
      expect(shaped.totalValue).toBe('100');
    });

    it('TC-1 (PERCENTAGE component): never emits totalValue, unitType or unitCode; emits averageRatePercent', () => {
      const shaped = shapeRewardGroup({
        rewardCategory: 'VOUCHER',
        rewardKind: 'PERCENTAGE',
        unitType: null,
        unitCode: null,
        totalValue: '10',
        totalCount: 1,
      }) as NonSummableRewardGroup;

      expect(hasKey(shaped, 'totalValue')).toBe(false);
      expect(hasKey(shaped, 'unitType')).toBe(false);
      expect(hasKey(shaped, 'unitCode')).toBe(false);
      expect(shaped.totalCount).toBe(1);
      expect(shaped.averageRatePercent).toBe('10.00');
    });

    it('averageRatePercent reflects a true average across a multi-row GROUP BY rollup, not just the first row', () => {
      // Two PERCENTAGE rewards summed to 25 across 2 occurrences -> average 12.50, not 25.00.
      const shaped = shapeRewardGroup({
        rewardCategory: 'VOUCHER',
        rewardKind: 'PERCENTAGE',
        totalValue: '25',
        totalCount: 2,
      }) as NonSummableRewardGroup;
      expect(shaped.averageRatePercent).toBe('12.50');
    });

    it('TC-5: reward_kind IS NULL emits totalCount only, never a fabricated totalValue', () => {
      const shaped = shapeRewardGroup({
        rewardCategory: 'CASHBACK',
        rewardKind: null,
        unitType: 'currency',
        unitCode: 'MYR',
        totalValue: '5.0000',
        totalCount: 1,
      }) as NonSummableRewardGroup;

      expect(hasKey(shaped, 'totalValue')).toBe(false);
      expect(hasKey(shaped, 'unitType')).toBe(false);
      expect(hasKey(shaped, 'unitCode')).toBe(false);
      expect(hasKey(shaped, 'averageRatePercent')).toBe(false);
      expect(shaped.rewardKind).toBeNull();
      expect(shaped.totalCount).toBe(1);
    });

    it('PHYSICAL: never emits totalValue or averageRatePercent (rate-only field, PERCENTAGE-specific)', () => {
      const shaped = shapeRewardGroup({
        rewardCategory: 'GIFT',
        rewardKind: 'PHYSICAL',
        totalValue: '1',
        totalCount: 3,
      }) as NonSummableRewardGroup;

      expect(hasKey(shaped, 'totalValue')).toBe(false);
      expect(hasKey(shaped, 'averageRatePercent')).toBe(false);
      expect(shaped.totalCount).toBe(3);
    });

    it('PROMO_CODE: emits promoCodeConfigId/promoCodeConfigVersionNo, never totalValue or averageRatePercent', () => {
      const shaped = shapeRewardGroup({
        rewardCategory: 'VOUCHER',
        rewardKind: 'PROMO_CODE',
        totalValue: '999',
        totalCount: 1,
        promoCodeConfigId: 'PCC-1',
        promoCodeConfigVersionNo: 3,
      }) as NonSummableRewardGroup;

      expect(hasKey(shaped, 'totalValue')).toBe(false);
      expect(hasKey(shaped, 'averageRatePercent')).toBe(false);
      expect(shaped.promoCodeConfigId).toBe('PCC-1');
      expect(shaped.promoCodeConfigVersionNo).toBe(3);
    });

    it('PROMO_CODE with no config id/version yet: omits both fields rather than emitting null', () => {
      const shaped = shapeRewardGroup({
        rewardCategory: 'VOUCHER',
        rewardKind: 'PROMO_CODE',
        totalValue: '0',
        totalCount: 1,
      }) as NonSummableRewardGroup;

      expect(hasKey(shaped, 'promoCodeConfigId')).toBe(false);
      expect(hasKey(shaped, 'promoCodeConfigVersionNo')).toBe(false);
    });

    it('does not mutate its input', () => {
      const input: RewardGroupInput = {
        rewardCategory: 'CASHBACK',
        rewardKind: 'FIXED_AMOUNT',
        unitType: 'currency',
        unitCode: 'MYR',
        totalValue: '5.0000',
        totalCount: 2,
      };
      const snapshot = { ...input };
      shapeRewardGroup(input);
      expect(input).toEqual(snapshot);
    });
  });
});
