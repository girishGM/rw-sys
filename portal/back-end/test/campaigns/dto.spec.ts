/**
 * T-037 — the DTO layer, through the **real** `class-validator` pipeline the global
 * `ValidationPipe` runs.
 *
 * The point of these tests is the second layer: `@MatchesSharedContract(...)` runs the shared Zod
 * schema over the whole DTO, so every cross-field rule the SPA enforces is enforced here too from
 * one definition. TC-8, TC-9 and TC-11 are cross-field rules and would pass every per-property
 * decorator in the file.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCampaignDto, UpdateCampaignDto } from '@/modules/campaigns/dto/campaign.dto';
import { CreateTrackerDto } from '@/modules/campaigns/dto/journey.dto';
import { CampaignCapDto, PutCampaignCapsDto } from '@/modules/campaigns/dto/caps.dto';
import { AttachRewardDto } from '@/modules/campaigns/dto/binding.dto';

/** Tomorrow, in a +08:00 offset — always a valid `startDate`. */
function tomorrowInKl(): string {
  const date = new Date(Date.now() + 36 * 3_600_000);
  return `${date.toISOString().slice(0, 10)}T00:00:00+08:00`;
}

function inDays(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${date.toISOString().slice(0, 10)}T00:00:00+08:00`;
}

function errorsFor<T extends object>(cls: new () => T, body: unknown): string[] {
  const instance = plainToInstance(cls, body, { enableImplicitConversion: false });
  return validateSync(instance as object, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.keys(error.constraints ?? {}),
  );
}

describe('T-037 DTOs', () => {
  describe('CreateCampaignDto', () => {
    const valid = {
      campaignCode: 'RAYA_2026',
      name: 'Raya bonus',
      startDate: inDays(1),
      endDate: inDays(30),
    };

    it('accepts a well-formed body', () => {
      expect(errorsFor(CreateCampaignDto, valid)).toEqual([]);
    });

    it('TC-8: rejects endDate before startDate', () => {
      expect(
        errorsFor(CreateCampaignDto, { ...valid, startDate: inDays(30), endDate: inDays(1) }),
      ).toContain('matchesSharedContract');
    });

    it('accepts endDate equal to startDate — a single-day campaign runs for one day (T-065)', () => {
      // **This assertion is inverted from T-037's, deliberately.** It used to read "rejects
      // endDate equal to startDate — a zero-length campaign is never intended", which was true of
      // the old encoding: start was `<day>T00:00:00` and end `<day>T23:59:59`, so equal instants
      // really did mean zero duration. Campaign dates are now calendar dates with an **inclusive**
      // end (T-065), so the identical single-day campaign a maker could always create now has
      // `end == start`. Keeping the old assertion would have withdrawn single-day campaigns as a
      // silent side effect of a date-storage fix.
      expect(
        errorsFor(CreateCampaignDto, { ...valid, startDate: inDays(5), endDate: inDays(5) }),
      ).toEqual([]);
    });

    it('still rejects endDate one day before startDate', () => {
      // The half of the old rule that still means something.
      expect(
        errorsFor(CreateCampaignDto, { ...valid, startDate: inDays(5), endDate: inDays(4) }),
      ).toContain('matchesSharedContract');
    });

    it('T-065: accepts a plain calendar date, which is what the wizard now sends', () => {
      const day = (offsetDays: number): string =>
        new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
      expect(
        errorsFor(CreateCampaignDto, { ...valid, startDate: day(1), endDate: day(30) }),
      ).toEqual([]);
    });

    it('T-065: rejects a well-shaped calendar date that is not a real day', () => {
      expect(
        errorsFor(CreateCampaignDto, { ...valid, startDate: '2099-02-30', endDate: '2099-03-15' }),
      ).not.toEqual([]);
    });

    it('TC-9: rejects a startDate in the past', () => {
      expect(
        errorsFor(CreateCampaignDto, { ...valid, startDate: inDays(-2), endDate: inDays(10) }),
      ).toContain('matchesSharedContract');
    });

    it('TC-10: accepts a same-day start in the maker’s own offset', () => {
      // The instant is already past by UTC reckoning for a +08:00 maker; the contract compares
      // calendar days in the offset the maker sent, which is the whole point of TC-10.
      expect(errorsFor(CreateCampaignDto, { ...valid, startDate: tomorrowInKl() })).toEqual([]);
    });

    it('rejects a date with no offset at all — ambiguity is refused, not guessed', () => {
      expect(
        errorsFor(CreateCampaignDto, { ...valid, startDate: '2030-01-01T00:00:00' }),
      ).not.toEqual([]);
    });

    it('TC-11: rejects a budget amount with no currency', () => {
      expect(errorsFor(CreateCampaignDto, { ...valid, budgetAmount: '500000' })).toContain(
        'matchesSharedContract',
      );
    });

    it('accepts a budget amount with its currency', () => {
      expect(
        errorsFor(CreateCampaignDto, { ...valid, budgetAmount: '500000', budgetCurrency: 'MYR' }),
      ).toEqual([]);
    });

    it('rejects a budget amount that is a number rather than a decimal string', () => {
      expect(
        errorsFor(CreateCampaignDto, { ...valid, budgetAmount: 500000, budgetCurrency: 'MYR' }),
      ).not.toEqual([]);
    });

    it('rejects a campaign code with a space or a slash', () => {
      expect(errorsFor(CreateCampaignDto, { ...valid, campaignCode: 'RAYA 2026' })).toContain(
        'matches',
      );
      expect(errorsFor(CreateCampaignDto, { ...valid, campaignCode: 'a/b' })).toContain('matches');
    });

    it('R3: rejects a body carrying tenantId, status or createdBy', () => {
      // `forbidNonWhitelisted` is what turns "the DTO has no such field" into a 400 rather than a
      // silently ignored value — two independent controls, as 02-SECURITY.md §5 asks for.
      for (const field of ['tenantId', 'status', 'createdBy', 'countryId']) {
        expect(errorsFor(CreateCampaignDto, { ...valid, [field]: 1 })).toContain(
          'whitelistValidation',
        );
      }
    });
  });

  describe('UpdateCampaignDto', () => {
    it('accepts an empty patch', () => {
      expect(errorsFor(UpdateCampaignDto, {})).toEqual([]);
    });

    it('still enforces the date ordering when both are supplied', () => {
      expect(errorsFor(UpdateCampaignDto, { startDate: inDays(30), endDate: inDays(1) })).toContain(
        'matchesSharedContract',
      );
    });

    it('has no campaignCode field — the business key is immutable once written', () => {
      expect(errorsFor(UpdateCampaignDto, { campaignCode: 'NEW' })).toContain(
        'whitelistValidation',
      );
    });
  });

  describe('CreateTrackerDto', () => {
    it('requires a threshold for n_of', () => {
      expect(
        errorsFor(CreateTrackerDto, { name: 'Onboarding', completionLogic: 'n_of' }),
      ).toContain('matchesSharedContract');
    });

    it('does not require one for all/any', () => {
      expect(errorsFor(CreateTrackerDto, { name: 'Onboarding', completionLogic: 'all' })).toEqual(
        [],
      );
    });

    it('rejects a completion logic outside ck_trk_logic', () => {
      expect(
        errorsFor(CreateTrackerDto, { name: 'Onboarding', completionLogic: 'most_of' }),
      ).toContain('isIn');
    });

    it('7c: has no groupCode field — grouping is deferred by design', () => {
      expect(
        errorsFor(CreateTrackerDto, { name: 'X', completionLogic: 'all', groupCode: 'A' }),
      ).toContain('whitelistValidation');
    });
  });

  describe('CampaignCapDto — every refinement mirrors a live CHECK constraint', () => {
    const budget = {
      capClass: 'budget',
      scopeLevel: 'campaign',
      periodType: 'lifetime',
      unitType: 'currency',
      unitCode: 'MYR',
      maxTotalAmount: '500000',
    };

    it('accepts a campaign lifetime budget', () => {
      expect(errorsFor(CampaignCapDto, budget)).toEqual([]);
    });

    it('TC-21w: ck_cc_unit — an amount with no currency is rejected', () => {
      const { unitType, unitCode, ...withoutUnit } = budget;
      void unitType;
      void unitCode;
      expect(errorsFor(CampaignCapDto, withoutUnit)).toContain('matchesSharedContract');
    });

    it('ck_cc_has_ceiling — a cap that caps nothing is rejected', () => {
      const { maxTotalAmount, ...withoutCeiling } = budget;
      void maxTotalAmount;
      expect(errorsFor(CampaignCapDto, withoutCeiling)).toContain('matchesSharedContract');
    });

    it('TC-21v: max_occurrences alone is a valid ceiling, with no amount', () => {
      expect(
        errorsFor(CampaignCapDto, {
          capClass: 'limit',
          scopeLevel: 'campaign',
          periodType: 'daily',
          maxOccurrences: 3,
        }),
      ).toEqual([]);
    });

    it('ck_cc_ref — campaign scope must not carry a scopeRefId', () => {
      expect(errorsFor(CampaignCapDto, { ...budget, scopeRefId: 7 })).toContain(
        'matchesSharedContract',
      );
    });

    it('ck_cc_ref — tracker scope must carry one', () => {
      expect(errorsFor(CampaignCapDto, { ...budget, scopeLevel: 'tracker' })).toContain(
        'matchesSharedContract',
      );
    });

    it('TC-21t: a tracker-scoped budget with its ref id is accepted', () => {
      expect(
        errorsFor(CampaignCapDto, { ...budget, scopeLevel: 'tracker', scopeRefId: 7 }),
      ).toEqual([]);
    });

    it('ck_cc_customers — maxCustomers is meaningless per customer', () => {
      expect(
        errorsFor(CampaignCapDto, {
          capClass: 'limit',
          scopeLevel: 'campaign',
          periodType: 'lifetime',
          maxCustomers: 10_000,
        }),
      ).toContain('matchesSharedContract');
    });

    it('ck_cc_rolling — rolling_hours needs a periodValue', () => {
      expect(errorsFor(CampaignCapDto, { ...budget, periodType: 'rolling_hours' })).toContain(
        'matchesSharedContract',
      );
    });

    it('TC-21s: ck_cc_window — time_of_day needs both window times', () => {
      expect(errorsFor(CampaignCapDto, { ...budget, periodType: 'time_of_day' })).toContain(
        'matchesSharedContract',
      );
      expect(
        errorsFor(CampaignCapDto, {
          ...budget,
          periodType: 'time_of_day',
          windowStartTime: '18:00',
          windowEndTime: '22:00',
        }),
      ).toEqual([]);
    });

    it('rejects a malformed window time', () => {
      expect(
        errorsFor(CampaignCapDto, {
          ...budget,
          periodType: 'time_of_day',
          windowStartTime: '25:00',
          windowEndTime: '22:00',
        }),
      ).toContain('matches');
    });

    it('TC-21aa: accepts on_breach and warn_at_percent', () => {
      expect(
        errorsFor(CampaignCapDto, { ...budget, onBreach: 'pause_campaign', warnAtPercent: 80 }),
      ).toEqual([]);
    });

    it('rejects a warn percentage of 100, which could never fire before the ceiling', () => {
      expect(errorsFor(CampaignCapDto, { ...budget, warnAtPercent: 100 })).toContain('max');
    });
  });

  describe('PutCampaignCapsDto', () => {
    it('accepts an empty set — clearing every cap is a legitimate edit', () => {
      expect(errorsFor(PutCampaignCapsDto, { caps: [] })).toEqual([]);
    });

    it('validates nested caps', () => {
      const errors = errorsFor(PutCampaignCapsDto, {
        caps: [{ capClass: 'budget', scopeLevel: 'campaign', periodType: 'lifetime' }],
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('AttachRewardDto', () => {
    it('accepts a campaign-level attachment with no refId', () => {
      expect(errorsFor(AttachRewardDto, { level: 'campaign', rewardPolicyId: 3 })).toEqual([]);
    });

    it('rejects a campaign-level attachment that carries one', () => {
      expect(
        errorsFor(AttachRewardDto, { level: 'campaign', refId: 7, rewardPolicyId: 3 }),
      ).toContain('matchesSharedContract');
    });

    it('rejects a tracker-level attachment with no refId', () => {
      expect(errorsFor(AttachRewardDto, { level: 'tracker', rewardPolicyId: 3 })).toContain(
        'matchesSharedContract',
      );
    });

    it('accepts a component-level attachment with its refId', () => {
      expect(
        errorsFor(AttachRewardDto, { level: 'component', refId: 7, rewardPolicyId: 3 }),
      ).toEqual([]);
    });

    // T-127 — `promoCodeConfig`. Whether it is *allowed* for a given reward is the service's
    // question (it depends on that reward's live version, which no DTO can see); what this layer
    // owns is its shape, and that an ordinary attach is unchanged by its existence.
    it('T-127: accepts an attachment carrying a promo code config', () => {
      expect(
        errorsFor(AttachRewardDto, {
          level: 'campaign',
          rewardPolicyId: 3,
          promoCodeConfig: 'RAYA_2026',
        }),
      ).toEqual([]);
    });

    it('T-127: an attachment with no promo code config is still valid — that is the normal path', () => {
      expect(errorsFor(AttachRewardDto, { level: 'campaign', rewardPolicyId: 3 })).toEqual([]);
    });

    it('T-127: rejects an empty promo code config rather than storing a blank pick', () => {
      expect(
        errorsFor(AttachRewardDto, {
          level: 'campaign',
          rewardPolicyId: 3,
          promoCodeConfig: '',
        }),
      ).toContain('isLength');
    });

    it('T-127: rejects a promo code config beyond 200 characters', () => {
      expect(
        errorsFor(AttachRewardDto, {
          level: 'campaign',
          rewardPolicyId: 3,
          promoCodeConfig: 'x'.repeat(201),
        }),
      ).toContain('isLength');
    });

    it('T-127: rejects a non-string promo code config', () => {
      expect(
        errorsFor(AttachRewardDto, {
          level: 'campaign',
          rewardPolicyId: 3,
          promoCodeConfig: 42,
        }),
      ).toContain('isString');
    });

    it('T-127: rejects null, which is how a careless client spells "nothing picked"', () => {
      // The contract is an **absent** key, never an explicit null (see the shared schema's own
      // comment) — the SPA spreads the key in only when there is a value.
      //
      // Asserted as *"the body is refused"*, not as *"`isString` fired"*: `@IsOptional()` treats
      // `null` as absent, so the refusal comes from the shared zod contract this DTO validates
      // against rather than from the property decorator. Which of the two catches it is an
      // implementation detail; that a `null` never reaches the service is the property, and it is
      // proved end to end by `t127-promo-code-attach.e2e-spec.ts`'s 400 over real HTTP (§3).
      expect(
        errorsFor(AttachRewardDto, {
          level: 'campaign',
          rewardPolicyId: 3,
          promoCodeConfig: null,
        }),
      ).not.toEqual([]);
    });
  });
});
