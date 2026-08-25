import {
  RULE_ERROR_CODE,
  RuleCodeExistsError,
  RuleHasCountryAssignmentsError,
  RuleInUseByCampaignError,
} from '@/modules/rules/rules.errors';

describe('rules.errors', () => {
  it('RuleCodeExistsError is a 409 with the RULE_CODE_EXISTS code', () => {
    const error = new RuleCodeExistsError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(RULE_ERROR_CODE.RULE_CODE_EXISTS);
  });

  it('RuleHasCountryAssignmentsError is a 422 whose details carry only country ids, never names', () => {
    const error = new RuleHasCountryAssignmentsError([1, 2, 3]);
    expect(error.status).toBe(422);
    expect(error.code).toBe(RULE_ERROR_CODE.RULE_HAS_COUNTRY_ASSIGNMENTS);
    expect(error.details).toEqual([
      { field: 'countryId', code: 'COUNTRY_1' },
      { field: 'countryId', code: 'COUNTRY_2' },
      { field: 'countryId', code: 'COUNTRY_3' },
    ]);
    // Never in `details` (client-facing) — only in `logContext` (server log only).
    expect(JSON.stringify(error.details)).not.toContain('name');
  });

  it('RuleInUseByCampaignError is a 422 whose details carry campaign ids, not names', () => {
    const error = new RuleInUseByCampaignError([
      { id: 10, name: 'Raya 2026 — has spaces & an ampersand' },
      { id: 11, name: 'Another campaign' },
    ]);
    expect(error.status).toBe(422);
    expect(error.code).toBe(RULE_ERROR_CODE.RULE_IN_USE_BY_CAMPAIGN);
    expect(error.details).toEqual([
      { field: 'campaignId', code: 'CAMPAIGN_10' },
      { field: 'campaignId', code: 'CAMPAIGN_11' },
    ]);
    // The free-text campaign name must never leak into the client-facing `details`.
    for (const detail of error.details ?? []) {
      expect(detail.code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
    }
  });

  it('logContext (server log only) carries the richer, human-readable form', () => {
    const error = new RuleInUseByCampaignError([{ id: 10, name: 'Raya 2026' }]);
    expect(error.logContext).toMatchObject({ campaigns: [{ id: 10, name: 'Raya 2026' }] });
  });
});
