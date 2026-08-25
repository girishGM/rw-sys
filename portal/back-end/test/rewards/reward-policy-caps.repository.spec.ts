/**
 * T-032 implementation note 5 — `reward-policy-caps.repository.ts`'s raw, parameterised queries.
 * Against a scripted `FakeSequelize` (`support/rewards-doubles.ts`): proves the exact SQL shape
 * (parameterised, never interpolated) and the row→camelCase mapping, the same division of labour
 * `rules/campaign-usage.query.ts`'s own tests draw between "the SQL is right" (here) and "the
 * live database actually has these privileges" (T-032 completion report).
 */
import {
  findRewardPolicyCap,
  insertRewardPolicyCap,
  listRewardPolicyCaps,
  updateRewardPolicyCap,
} from '@/modules/rewards/reward-policy-caps.repository';
import { FakeSequelize, asSequelize } from './support/rewards-doubles';

const RAW_ROW = {
  id: 1,
  reward_policy_id: 10,
  cap_type: 'per_customer',
  frequency_value: 1,
  frequency_unit: 'day',
  max_occurrences: 3,
  max_total_amount: '50.0000',
  status: 'active',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
};

describe('listRewardPolicyCaps', () => {
  it('binds rewardPolicyId as a replacement and maps decimal(18,4) to a number', async () => {
    const sequelize = new FakeSequelize().setQueryResult([RAW_ROW]);

    const rows = await listRewardPolicyCaps(asSequelize(sequelize), 10);

    expect(rows).toEqual([
      {
        id: 1,
        rewardPolicyId: 10,
        capType: 'per_customer',
        frequencyValue: 1,
        frequencyUnit: 'day',
        maxOccurrences: 3,
        maxTotalAmount: 50,
        status: 'active',
        createdAt: RAW_ROW.created_at,
        updatedAt: RAW_ROW.updated_at,
      },
    ]);
    expect(sequelize.queryCalls[0]?.statement).toContain('reward_config.reward_policy_caps');
    expect(
      (sequelize.queryCalls[0]?.options as { replacements: Record<string, unknown> }).replacements,
    ).toEqual({ rewardPolicyId: 10 });
  });

  it('maps a null max_total_amount to null, not NaN', async () => {
    const sequelize = new FakeSequelize().setQueryResult([{ ...RAW_ROW, max_total_amount: null }]);
    const rows = await listRewardPolicyCaps(asSequelize(sequelize), 10);
    expect(rows[0]?.maxTotalAmount).toBeNull();
  });
});

describe('findRewardPolicyCap', () => {
  it('returns null when no row matches', async () => {
    const sequelize = new FakeSequelize().setQueryResult([]);
    expect(await findRewardPolicyCap(asSequelize(sequelize), 1, 10)).toBeNull();
  });

  it('binds both id and rewardPolicyId', async () => {
    const sequelize = new FakeSequelize().setQueryResult([RAW_ROW]);
    const row = await findRewardPolicyCap(asSequelize(sequelize), 1, 10);
    expect(row?.id).toBe(1);
    expect(
      (sequelize.queryCalls[0]?.options as { replacements: Record<string, unknown> }).replacements,
    ).toEqual({ id: 1, rewardPolicyId: 10 });
  });
});

describe('insertRewardPolicyCap', () => {
  it('inserts with status hard-coded to active and returns the inserted row', async () => {
    const sequelize = new FakeSequelize().setQueryResult([RAW_ROW]);

    const row = await insertRewardPolicyCap(asSequelize(sequelize), {
      rewardPolicyId: 10,
      capType: 'per_customer',
      frequencyValue: 1,
      frequencyUnit: 'day',
      maxOccurrences: 3,
      maxTotalAmount: 50,
    });

    expect(row.id).toBe(1);
    expect(sequelize.queryCalls[0]?.statement).toContain(
      'INSERT INTO reward_config.reward_policy_caps',
    );
    expect(sequelize.queryCalls[0]?.statement).toContain("'active'");
    expect(
      (sequelize.queryCalls[0]?.options as { replacements: Record<string, unknown> }).replacements,
    ).toMatchObject({ rewardPolicyId: 10, capType: 'per_customer' });
  });
});

describe('updateRewardPolicyCap', () => {
  it('builds SET only for the supplied keys', async () => {
    const sequelize = new FakeSequelize().setQueryResult([{ ...RAW_ROW, status: 'inactive' }]);

    const row = await updateRewardPolicyCap(asSequelize(sequelize), 1, 10, {
      status: 'inactive',
    });

    expect(row?.status).toBe('inactive');
    const statement = sequelize.queryCalls[0]?.statement as string;
    expect(statement).toContain('status = :status');
    expect(statement).not.toContain('frequency_value = :frequencyValue');
  });

  it('treats an explicit null as "clear this column"', async () => {
    const sequelize = new FakeSequelize().setQueryResult([
      { ...RAW_ROW, frequency_value: null, frequency_unit: null },
    ]);

    await updateRewardPolicyCap(asSequelize(sequelize), 1, 10, {
      frequencyValue: null,
      frequencyUnit: null,
    });

    const replacements = (
      sequelize.queryCalls[0]?.options as { replacements: Record<string, unknown> }
    ).replacements;
    expect(replacements['frequencyValue']).toBeNull();
    expect(replacements['frequencyUnit']).toBeNull();
  });

  it('returns the current row (read-only query) when no changes were supplied', async () => {
    const sequelize = new FakeSequelize().setQueryResult([RAW_ROW]);

    const row = await updateRewardPolicyCap(asSequelize(sequelize), 1, 10, {});

    expect(row?.id).toBe(1);
    expect(sequelize.queryCalls[0]?.statement).not.toContain('UPDATE');
  });

  it('returns null when no row matches (caller answers 404)', async () => {
    const sequelize = new FakeSequelize().setQueryResult([]);
    const row = await updateRewardPolicyCap(asSequelize(sequelize), 999, 10, {
      status: 'inactive',
    });
    expect(row).toBeNull();
  });
});
