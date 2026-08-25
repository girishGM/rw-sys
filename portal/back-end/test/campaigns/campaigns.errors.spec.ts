/**
 * T-037 — the module's error vocabulary.
 *
 * Two things are asserted for every error: the **status code** the task file demands (a 400 where
 * it says 400, a 422 where it says 422 — these are not interchangeable, and TC-15 versus TC-21i
 * turns on the difference), and that every `details` entry survives
 * `ErrorNormalizationFilter`'s safety patterns. An error whose details are silently dropped is an
 * error the maker cannot act on.
 */
import { isSafeDetail, isSafeErrorCode } from '@/common/errors/app-error';
import {
  ActivityNotOfferedError,
  BudgetExceedsTenantCeilingError,
  CampaignCodeExistsError,
  CampaignNotEditableError,
  CampaignStructureIncompleteError,
  CampaignTransitionNotAllowedError,
  CapCurrencyMismatchError,
  CodeGenerationFailedError,
  CAMPAIGN_ERROR_CODE,
  MerchantNotInTenantError,
  NotPartOfCampaignError,
  RewardAlreadyAttachedError,
  RewardNotAssignedToCountryError,
  RuleAlreadyBoundError,
  RuleNotAssignedToCountryError,
  UnachievableThresholdError,
} from '@/modules/campaigns/campaigns.errors';

describe('T-037 campaign errors', () => {
  it('every code is safe to serialise into a response body', () => {
    for (const code of Object.values(CAMPAIGN_ERROR_CODE)) {
      expect(isSafeErrorCode(code)).toBe(true);
    }
  });

  describe('status codes the task file fixes', () => {
    it('TC-6: a duplicate campaign code is a 409', () => {
      expect(new CampaignCodeExistsError().status).toBe(409);
    });

    it('an edit outside draft is a 409, not a 403 — the caller has the permission', () => {
      expect(new CampaignNotEditableError('active').status).toBe(409);
    });

    it('an illegal transition is a 409', () => {
      expect(new CampaignTransitionNotAllowedError('active', 'submit').status).toBe(409);
    });

    it('TC-15: an unassigned rule is a **400**, not a 404 — see campaigns.errors.ts header', () => {
      expect(new RuleNotAssignedToCountryError(7).status).toBe(400);
    });

    it('TC-21: an unassigned reward policy is a 400 too', () => {
      expect(new RewardNotAssignedToCountryError(7).status).toBe(400);
    });

    it('TC-13: a merchant from another tenant is a 400', () => {
      expect(new MerchantNotInTenantError([9]).status).toBe(400);
    });

    it('TC-21h: an activity no chosen merchant offers is a 400', () => {
      expect(new ActivityNotOfferedError(5).status).toBe(400);
    });

    it('TC-21e: an unachievable threshold is a 400', () => {
      expect(new UnachievableThresholdError(4, 3).status).toBe(400);
    });

    it('TC-21q: a tracker from another campaign is a 400', () => {
      expect(new NotPartOfCampaignError('trackerId', 3).status).toBe(400);
    });

    it('TC-21i/j/o: structural incompleteness at submit is a 422', () => {
      expect(new CampaignStructureIncompleteError([]).status).toBe(422);
    });

    it('TC-21ff/kk: the tenant ceiling is a 422', () => {
      const error = new BudgetExceedsTenantCeilingError([
        { unitType: 'currency', unitCode: 'MYR' },
      ]);
      expect(error.status).toBe(422);
      expect(error.code).toBe('BUDGET_EXCEEDS_TENANT_CEILING');
    });

    it('TC-21bb: an unconfirmed currency mismatch is a 400', () => {
      expect(new CapCurrencyMismatchError(['SGD']).status).toBe(400);
    });

    it('a duplicate reward attachment is a 409', () => {
      expect(new RewardAlreadyAttachedError().status).toBe(409);
    });

    it('a duplicate rule binding is a 409', () => {
      expect(new RuleAlreadyBoundError().status).toBe(409);
    });

    it('exhausted code generation is a 500 — nothing the caller sent caused it', () => {
      const error = new CodeGenerationFailedError('TRK');
      expect(error.status).toBe(500);
      expect(error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('details survive the response-body safety filter', () => {
    const errors = [
      new RuleNotAssignedToCountryError(7),
      new RewardNotAssignedToCountryError(7),
      new MerchantNotInTenantError([9, 10]),
      new ActivityNotOfferedError(5),
      new UnachievableThresholdError(4, 3),
      new NotPartOfCampaignError('componentId', 3),
      new BudgetExceedsTenantCeilingError([{ unitType: 'points', unitCode: 'PTS' }]),
      new CapCurrencyMismatchError(['SGD', 'USD']),
      new CampaignStructureIncompleteError([
        { field: 'trackerId', code: 'TRACKER_HAS_NO_COMPONENT' },
      ]),
    ];

    it.each(errors.map((error) => [error.constructor.name, error] as const))(
      '%s',
      (_name, error) => {
        for (const detail of error.details ?? []) {
          expect(isSafeDetail(detail)).toBe(true);
        }
      },
    );
  });

  it('carries the richer, human-readable form on logContext only — never in details', () => {
    const error = new MerchantNotInTenantError([9, 10]);
    expect(error.logContext).toEqual({ merchantIds: [9, 10] });
    expect(JSON.stringify(error.details)).not.toContain('logContext');
  });
});
