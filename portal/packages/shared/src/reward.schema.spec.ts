/**
 * T-119 — the reward version `Kind`/`value_config` contract (13-REWARD-MASTER-VALUE-SOURCES.md
 * §5). `reward.schema.ts` had no spec file before this task; this one deliberately covers only
 * what T-119 added rather than retro-fitting tests over T-032's own schemas.
 *
 * The cases below are the shared-schema half of the task's TC-1…TC-5 — the half that decides
 * *what shape is legal*, asserted against the same schema object the back end's
 * `RewardVersionsService` and the SPA's Reward Master editor (T-120) both call. The HTTP status
 * codes those cases also name are asserted in `back-end/test/versions/reward-version-kind.spec.ts`.
 */
import {
  REWARD_KINDS,
  createRewardVersionRequestSchema,
  isRewardVersionValue,
  rewardVersionValueSchema,
} from './reward.schema';
import { rewardVersionSchema, updateRewardVersionRequestSchema } from './version.schema';

function validRewardVersionResponse() {
  return {
    id: 200,
    rewardId: 1,
    versionNo: 1,
    connectorConfig: {},
    deliveryMode: 'realtime',
    retryConfig: {},
    policiesSnapshot: null,
    unitType: 'currency',
    unitCode: 'USD',
    changeSummary: null,
    isBreaking: false,
    status: 'draft' as const,
    supersedesVersionId: null,
    originRequestId: null,
    createdBy: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    publishedBy: null,
    publishedAt: null,
    deprecatedAt: null,
    retiredAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    suggestedIsBreaking: null,
  };
}

describe('rewardVersionValueSchema — the five Kinds', () => {
  it('names exactly the five Kinds `ck_rewv_reward_kind` allows', () => {
    expect([...REWARD_KINDS]).toEqual([
      'FIXED_AMOUNT',
      'PERCENTAGE',
      'POINTS',
      'PHYSICAL',
      'PROMO_CODE',
    ]);
  });

  it('TC-1 — FIXED_AMOUNT accepts a multi-currency config with two currencies', () => {
    const result = rewardVersionValueSchema.safeParse({
      rewardKind: 'FIXED_AMOUNT',
      valueConfig: {
        multiCurrency: true,
        currencyValues: [
          { currency: 'MYR', value: 10 },
          { currency: 'SGD', value: 3.5 },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('FIXED_AMOUNT accepts the single-currency shape', () => {
    expect(
      isRewardVersionValue('FIXED_AMOUNT', {
        multiCurrency: false,
        defaultCurrency: 'MYR',
        defaultValue: 10,
      }),
    ).toBe(true);
  });

  it('TC-2 — FIXED_AMOUNT rejects multiCurrency: true with an empty currencyValues', () => {
    expect(isRewardVersionValue('FIXED_AMOUNT', { multiCurrency: true, currencyValues: [] })).toBe(
      false,
    );
  });

  it('rejects a multi-currency config that repeats a currency', () => {
    expect(
      isRewardVersionValue('FIXED_AMOUNT', {
        multiCurrency: true,
        currencyValues: [
          { currency: 'MYR', value: 10 },
          { currency: 'MYR', value: 12 },
        ],
      }),
    ).toBe(false);
  });

  it('rejects the two FIXED_AMOUNT shapes mixed together', () => {
    expect(
      isRewardVersionValue('FIXED_AMOUNT', {
        multiCurrency: false,
        defaultCurrency: 'MYR',
        defaultValue: 10,
        currencyValues: [{ currency: 'SGD', value: 1 }],
      }),
    ).toBe(false);
  });

  it('rejects a currency that is not a 3-letter ISO-4217 code', () => {
    expect(
      isRewardVersionValue('FIXED_AMOUNT', {
        multiCurrency: false,
        defaultCurrency: 'ringgit',
        defaultValue: 10,
      }),
    ).toBe(false);
  });

  it('TC-3 — PERCENTAGE rejects 150 and accepts 0 and 100', () => {
    expect(isRewardVersionValue('PERCENTAGE', { percentage: 150 })).toBe(false);
    expect(isRewardVersionValue('PERCENTAGE', { percentage: 0 })).toBe(true);
    expect(isRewardVersionValue('PERCENTAGE', { percentage: 100 })).toBe(true);
  });

  it('POINTS accepts a non-negative count and rejects a negative one', () => {
    expect(isRewardVersionValue('POINTS', { points: 0 })).toBe(true);
    expect(isRewardVersionValue('POINTS', { points: -1 })).toBe(false);
  });

  it('PHYSICAL requires both a sku and a description', () => {
    expect(isRewardVersionValue('PHYSICAL', { sku: 'MUG-001', description: 'Branded mug' })).toBe(
      true,
    );
    expect(isRewardVersionValue('PHYSICAL', { sku: 'MUG-001' })).toBe(false);
    expect(isRewardVersionValue('PHYSICAL', { sku: '', description: 'Branded mug' })).toBe(false);
  });

  it('TC-5 — PROMO_CODE accepts the seeded PROMO_CODE_CONFIG_SERVICE provider', () => {
    expect(
      isRewardVersionValue('PROMO_CODE', {
        apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
        bindLevels: ['component', 'campaign'],
      }),
    ).toBe(true);
  });

  it('TC-4 — PROMO_CODE rejects an empty bindLevels', () => {
    expect(
      isRewardVersionValue('PROMO_CODE', {
        apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
        bindLevels: [],
      }),
    ).toBe(false);
  });

  it('PROMO_CODE rejects an unknown provider code and an unknown bind level', () => {
    expect(
      isRewardVersionValue('PROMO_CODE', {
        apiProvider: 'MY_OWN_SERVICE',
        bindLevels: ['tracker'],
      }),
    ).toBe(false);
    expect(
      isRewardVersionValue('PROMO_CODE', {
        apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
        bindLevels: ['journey'],
      }),
    ).toBe(false);
  });

  it('PROMO_CODE carries no amount — an added value key is rejected, not ignored', () => {
    expect(
      isRewardVersionValue('PROMO_CODE', {
        apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
        bindLevels: ['campaign'],
        defaultValue: 25,
      }),
    ).toBe(false);
  });

  it('judges a config against the Kind it was authored for, not any Kind', () => {
    expect(isRewardVersionValue('POINTS', { percentage: 50 })).toBe(false);
    expect(isRewardVersionValue('PERCENTAGE', { points: 50 })).toBe(false);
  });
});

describe('isRewardVersionValue — the two null cases', () => {
  it('TC-7 — a version with neither a Kind nor a value config is valid', () => {
    expect(isRewardVersionValue(null, null)).toBe(true);
  });

  it('a Kind with no value config yet is a legitimate draft state', () => {
    expect(isRewardVersionValue('PERCENTAGE', null)).toBe(true);
    expect(isRewardVersionValue('PERCENTAGE', undefined)).toBe(true);
  });

  it('a value config with no Kind has no schema to judge it by, so it is refused', () => {
    expect(isRewardVersionValue(null, { percentage: 10 })).toBe(false);
  });
});

describe('createRewardVersionRequestSchema / updateRewardVersionRequestSchema', () => {
  it('accepts a create body carrying only the bookkeeping fields', () => {
    expect(createRewardVersionRequestSchema.safeParse({ changeSummary: 'v2' }).success).toBe(true);
  });

  it('TC-1 — accepts a create body carrying a Kind and its config', () => {
    expect(
      createRewardVersionRequestSchema.safeParse({
        rewardKind: 'FIXED_AMOUNT',
        valueConfig: {
          multiCurrency: true,
          currencyValues: [
            { currency: 'MYR', value: 10 },
            { currency: 'SGD', value: 3.5 },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('TC-3 — rejects a create body whose config does not match its Kind', () => {
    const result = createRewardVersionRequestSchema.safeParse({
      rewardKind: 'PERCENTAGE',
      valueConfig: { percentage: 150 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a config with no Kind, pathed at rewardKind', () => {
    const result = createRewardVersionRequestSchema.safeParse({ valueConfig: { percentage: 10 } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].path).toEqual(['rewardKind']);
  });

  it('rejects an unknown key (both request schemas are strict)', () => {
    expect(createRewardVersionRequestSchema.safeParse({ rewardId: 3 }).success).toBe(false);
    expect(updateRewardVersionRequestSchema.safeParse({ rewardId: 3 }).success).toBe(false);
  });

  it('lets a PATCH clear the Kind back to null', () => {
    expect(
      updateRewardVersionRequestSchema.safeParse({ rewardKind: null, valueConfig: null }).success,
    ).toBe(true);
  });

  it('lets a PATCH send one half of the pair — the server merges the other', () => {
    expect(updateRewardVersionRequestSchema.safeParse({ rewardKind: 'POINTS' }).success).toBe(true);
  });
});

describe('rewardVersionSchema — the response contract the SPA validates', () => {
  it('accepts a response carrying the Kind pair', () => {
    const result = rewardVersionSchema.safeParse({
      ...validRewardVersionResponse(),
      rewardKind: 'POINTS',
      valueConfig: { points: 500 },
    });
    expect(result.success).toBe(true);
  });

  it('TC-7 — accepts a response whose Kind pair is null', () => {
    expect(
      rewardVersionSchema.safeParse({
        ...validRewardVersionResponse(),
        rewardKind: null,
        valueConfig: null,
      }).success,
    ).toBe(true);
  });

  it('still accepts a response from a server that predates T-119', () => {
    expect(rewardVersionSchema.safeParse(validRewardVersionResponse()).success).toBe(true);
  });

  it('rejects a Kind outside the vocabulary', () => {
    expect(
      rewardVersionSchema.safeParse({
        ...validRewardVersionResponse(),
        rewardKind: 'GIFT_CARD',
      }).success,
    ).toBe(false);
  });
});
