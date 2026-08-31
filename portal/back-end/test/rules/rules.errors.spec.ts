import {
  RULE_ERROR_CODE,
  RuleCodeExistsError,
  RuleHasCountryAssignmentsError,
  RuleInUseByCampaignError,
  UnknownFieldValueSourceProviderError,
} from '@/modules/rules/rules.errors';
import { isSafeDetail } from '@/common/errors/app-error';

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

  // T-122 — the detail this error carries must survive `ErrorNormalizationFilter`. A detail that
  // fails `isSafeDetail` is silently dropped, which would leave the caller a bare 400 with no
  // indication of *which* field named the bad provider — the one thing this error exists to say.
  describe('UnknownFieldValueSourceProviderError (T-122)', () => {
    it('is a 400 naming the offending field and provider code', () => {
      const error = new UnknownFieldValueSourceProviderError('targetComponentCode', 'NO_SUCH');
      expect(error.status).toBe(400);
      expect(error.code).toBe(RULE_ERROR_CODE.UNKNOWN_FIELD_VALUE_SOURCE_PROVIDER);
      expect(error.details).toEqual([
        { field: 'parameters.targetComponentCode', code: 'PROVIDER_NO_SUCH' },
      ]);
    });

    it('its detail passes isSafeDetail at the longest key/code the schemas allow', () => {
      // 64 chars — `rule.schema.ts`'s `key` regex maximum; 50 chars — `providerCodeSchema`'s max.
      const longestKey = `k${'e'.repeat(63)}`;
      const longestCode = `P${'R'.repeat(49)}`;
      const error = new UnknownFieldValueSourceProviderError(longestKey, longestCode);

      expect(longestKey).toHaveLength(64);
      expect(longestCode).toHaveLength(50);
      for (const detail of error.details ?? []) {
        expect(isSafeDetail(detail)).toBe(true);
      }
    });

    it('keeps the readable pair on logContext for the server log', () => {
      const error = new UnknownFieldValueSourceProviderError('productId', 'PRODUCT_CATALOG');
      expect(error.logContext).toMatchObject({
        fieldKey: 'productId',
        providerCode: 'PRODUCT_CATALOG',
      });
    });
  });
});
