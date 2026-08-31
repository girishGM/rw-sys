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
  createRewardRequestSchema,
  createRewardVersionRequestSchema,
  isRewardVersionValue,
  rewardListItemSchema,
  rewardSchema,
  rewardVersionValueSchema,
} from './reward.schema';
import { rewardVersionSchema, updateRewardVersionRequestSchema } from './version.schema';

/** One valid `GET /rewards` row — every field `rewardListItemSchema` requires. */
function validRewardListRow() {
  return {
    id: 1,
    systemCode: 'CASHBACK_STANDARD',
    name: 'Standard cashback',
    description: null,
    rewardType: 'monetary',
    deliveryMode: 'realtime' as const,
    connectorType: 'internal_api',
    maintenanceWindowEnabled: false,
    maintenanceSchedule: {},
    retryEnabled: true,
    retryConfig: {},
    merchantId: null,
    categoryId: 1,
    categoryName: 'Uncategorized',
    subCategoryId: null,
    subCategoryName: null,
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

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

/**
 * T-158 — a `super_admin`'s `GET /rewards` (unscoped: every `reward_systems` row, not just the
 * caller's assigned ones) rendered the SPA's generic `UNKNOWN_ERROR_MESSAGE` instead of the list,
 * root-caused directly against a real local Postgres: 16 rows carry `connector_type = 'internal'`
 * — a pre-rename value the current `REWARD_CONNECTOR_TYPES` enum no longer includes, left behind
 * by e2e fixtures that write directly to `reward_config.reward_systems` and bypass `POST
 * /rewards`'s own validation. `rewardListItemSchema`/`rewardSchema` used the same strict enum
 * (`rewardConnectorTypeSchema`) for reads as for writes, so `.safeParse` failed on the *whole*
 * array the moment any one row carried it — a `country_admin` whose one visible reward happened
 * to carry a valid value never saw the failure at all, which is exactly why this shipped
 * unnoticed. These cases pin the read/write split the fix introduces: reads tolerate a legacy
 * value (this is the regression proof — red on `rewardConnectorTypeSchema`, green on
 * `rewardConnectorTypeReadSchema`), writes still reject one, same as before. */
describe('reward connectorType — read is lenient, write stays a closed enum (T-158)', () => {
  it('rewardListItemSchema accepts a legacy connectorType a POST would never have accepted', () => {
    const row = { ...validRewardListRow(), connectorType: 'internal' };
    expect(rewardListItemSchema.safeParse(row).success).toBe(true);
  });

  it('rewardSchema (detail) accepts the same legacy value', () => {
    const detail = {
      ...validRewardListRow(),
      connectorConfigPreview: null,
      connectorType: 'internal',
    };
    expect(rewardSchema.safeParse(detail).success).toBe(true);
  });

  it('a whole list still fails closed on a genuinely malformed row — this is not "accept anything"', () => {
    // An empty string carries no information at all; the read schema still bounds shape/length
    // (`rewardConnectorTypeReadSchema`'s own `min(1).max(20)`), it just no longer requires
    // membership in the closed enum.
    const row = { ...validRewardListRow(), connectorType: '' };
    expect(rewardListItemSchema.safeParse(row).success).toBe(false);
  });

  it('createRewardRequestSchema (write) still rejects the same legacy value — TC regression guard', () => {
    const result = createRewardRequestSchema.safeParse({
      systemCode: 'CASHBACK_STANDARD',
      name: 'Standard cashback',
      rewardType: 'monetary',
      connectorType: 'internal',
      categoryId: 1,
    });
    expect(result.success).toBe(false);
  });

  it('createRewardRequestSchema (write) still accepts every current enum value', () => {
    for (const connectorType of ['internal_api', 'file_export', 'webhook', 'manual'] as const) {
      const result = createRewardRequestSchema.safeParse({
        systemCode: 'CASHBACK_STANDARD',
        name: 'Standard cashback',
        rewardType: 'monetary',
        connectorType,
        categoryId: 1,
      });
      expect(result.success).toBe(true);
    }
  });
});
