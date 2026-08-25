import {
  REWARD_ERROR_CODE,
  RewardHasCountryAssignmentsError,
  RewardInUseByCampaignError,
  RewardPolicyCodeExistsError,
  RewardSystemCodeExistsError,
} from '@/modules/rewards/rewards.errors';

describe('rewards.errors', () => {
  it('RewardSystemCodeExistsError is a 409 with the REWARD_SYSTEM_CODE_EXISTS code', () => {
    const error = new RewardSystemCodeExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(REWARD_ERROR_CODE.REWARD_SYSTEM_CODE_EXISTS);
  });

  it('RewardPolicyCodeExistsError is a 409 with the REWARD_POLICY_CODE_EXISTS code', () => {
    const error = new RewardPolicyCodeExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(REWARD_ERROR_CODE.REWARD_POLICY_CODE_EXISTS);
  });

  it('RewardHasCountryAssignmentsError is a 422 whose details carry only country ids, never names', () => {
    const error = new RewardHasCountryAssignmentsError([1, 2, 3]);
    expect(error.status).toBe(422);
    expect(error.code).toBe(REWARD_ERROR_CODE.REWARD_HAS_COUNTRY_ASSIGNMENTS);
    expect(error.details).toEqual([
      { field: 'countryId', code: 'COUNTRY_1' },
      { field: 'countryId', code: 'COUNTRY_2' },
      { field: 'countryId', code: 'COUNTRY_3' },
    ]);
    expect(JSON.stringify(error.details)).not.toContain('name');
  });

  it('RewardInUseByCampaignError is a 422 whose details carry campaign ids, not names', () => {
    const error = new RewardInUseByCampaignError([
      { id: 10, name: 'Raya 2026 — has spaces & an ampersand' },
      { id: 11, name: 'Another campaign' },
    ]);
    expect(error.status).toBe(422);
    expect(error.code).toBe(REWARD_ERROR_CODE.REWARD_IN_USE_BY_CAMPAIGN);
    expect(error.details).toEqual([
      { field: 'campaignId', code: 'CAMPAIGN_10' },
      { field: 'campaignId', code: 'CAMPAIGN_11' },
    ]);
    for (const detail of error.details ?? []) {
      expect(detail.code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
    }
  });

  it('logContext (server log only) carries the richer, human-readable form', () => {
    const error = new RewardInUseByCampaignError([{ id: 10, name: 'Raya 2026' }]);
    expect(error.logContext).toMatchObject({ campaigns: [{ id: 10, name: 'Raya 2026' }] });
  });
});
