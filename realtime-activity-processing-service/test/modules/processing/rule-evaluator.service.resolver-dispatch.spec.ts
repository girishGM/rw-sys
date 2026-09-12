/**
 * T-RAP-064 (Phase 2 of the rule-expression binding fix — see
 * `realtime-activity-processing-service-plan/brain-storm/T-RAP-063-rule-expression-binding-diagnosis.md`
 * for the full evidence base). Covers `RuleEvaluatorService.evaluate()`'s resolver-dispatch wiring
 * end to end (TC-1/TC-2/TC-3/TC-5 of this task's own test table) — `ScheduleContextResolver`'s own
 * unit behavior is covered separately, `resolvers/schedule-context.resolver.spec.ts`.
 *
 * **Path note (deviation from the task file's own listed path)** — same reasoning as
 * `resolvers/schedule-context.resolver.spec.ts`'s own header: this repo's real, granted
 * `test/modules/processing/**` scope and established `test/modules/*` mirroring convention, not
 * the task file's literal `test/processing/...`.
 *
 * **TC-4 (operator) is not covered here** — `RULE_ACTIVITY_VALUE_001`'s `:operator` clause remains
 * exactly as `T-RAP-063` left it (unresolved, not-passed, logged), unaffected by this task. Still
 * blocked on the Phase 3 product decision (`BACKLOG.md` RS-05, `decision-needed` as of 2026-09-12)
 * — see this task's own completion report.
 *
 * **TC-3 adaptation** — the task file's own wording is "a `resolver_id` present on the wire with no
 * matching registry entry". This codebase does not read `resolver_id` off the wire at all (see
 * `resolvers/rule-resolver.interface.ts`'s own header on the scope conflict that caused this), so
 * the literal scenario can't be constructed. The closest faithful proxy exercised below: a clause
 * that superficially resembles a resolver-dispatch shape but that **no registered resolver
 * recognizes** — proving the exact same safe fallback (not-passed, logged warning, never a throw)
 * the literal TC-3 scenario is meant to prove, via `resolveClause`'s own "no resolver claims it ->
 * fall through to Phase 1" path.
 */
import { Logger } from '@nestjs/common';
import { RuleEvaluatorService } from '@/modules/processing/rule-evaluator.service';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import type { BoundRuleProto } from '@/modules/campaign-cache/campaign-config.client';

function fakeRow(overrides: Partial<ActivityLogRow> = {}): ActivityLogRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    correlation_id: '22222222-2222-4222-8222-222222222222',
    dedup_key: 'dedup-1',
    tenant_id: 1,
    customer_id_encrypted: 'ciphertext',
    customer_id_hash: 'a'.repeat(64),
    customer_id_type: 'INTERNAL_ID',
    activity_performed_date: new Date('2026-01-01T12:00:00.000Z'),
    transaction_type: null,
    activity_code: 'PURCHASE',
    activity_type: 'TRANSACTION',
    activity_category: 'RETAIL',
    activity_value: '10.0000',
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 'Online purchase',
    campaign_code: 'CMP-530457-JHISLD',
    tracker_code: 'TRK-530457-OQIDT5',
    tracker_component_code: 'COMP-530457',
    merchant_code: null,
    source_transport: 'GRPC',
    activity_reached_date: new Date('2026-01-01T12:00:00.000Z'),
    activity_processed_date: null,
    status: 'processing',
    error_code: null,
    comment: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function rule(overrides: Partial<BoundRuleProto> = {}): BoundRuleProto {
  return {
    ruleId: 1,
    ruleVersionId: 1,
    versionNo: 1,
    ruleCode: 'RULE_MIN_VALUE',
    expression: 'activity.activity_value >= 1',
    parametersJson: '{}',
    boundValuesJson: '{}',
    trackerComponentId: 901,
    status: 'active',
    ...overrides,
  };
}

// The exact real row (diagnosis doc §3, row set B): WELCOME_STREAK_LIVE /
// TRK-530457-OQIDT5 / CMP-530457-JHISLD, RULE_ACTIVITY_WINDOW_001.
const windowRule = (overrides: Partial<BoundRuleProto> = {}) =>
  rule({
    ruleCode: 'RULE_ACTIVITY_WINDOW_001',
    expression: 'currentTime within the :windowType window',
    boundValuesJson: '{"windowType":"DAILY_HOURS","windowStart":"00:00","windowEnd":"23:59"}',
    ...overrides,
  });

describe('RuleEvaluatorService — T-RAP-064 resolver dispatch (pure, no DB)', () => {
  const evaluator = new RuleEvaluatorService();

  // TC-1: real activity timestamp inside the configured window.
  it('TC-1: RULE_ACTIVITY_WINDOW_001 evaluates passed:true for an activity inside the window', () => {
    const outcome = evaluator.evaluate(fakeRow(), [windowRule()]);
    expect(outcome).toEqual({ passed: true, failedRuleCode: null, comment: expect.any(String) });
  });

  // TC-1 (narrower window variant) — proves this isn't just "always true because the one live
  // window happens to span the full day".
  it('TC-1 variant: a narrower window still evaluates passed:true when the activity time is inside it', () => {
    const outcome = evaluator.evaluate(
      fakeRow({ activity_performed_date: new Date('2026-01-01T12:00:00.000Z') }),
      [
        windowRule({
          boundValuesJson: '{"windowType":"DAILY_HOURS","windowStart":"09:00","windowEnd":"17:00"}',
        }),
      ],
    );
    expect(outcome.passed).toBe(true);
  });

  // TC-2: activity timestamp outside the configured window — never throws.
  it('TC-2: RULE_ACTIVITY_WINDOW_001 evaluates passed:false (no throw) for an activity outside the window', () => {
    let outcome: ReturnType<typeof evaluator.evaluate> | undefined;
    expect(() => {
      outcome = evaluator.evaluate(
        fakeRow({ activity_performed_date: new Date('2026-01-01T20:00:00.000Z') }),
        [
          windowRule({
            boundValuesJson:
              '{"windowType":"DAILY_HOURS","windowStart":"09:00","windowEnd":"17:00"}',
          }),
        ],
      );
    }).not.toThrow();
    expect(outcome?.passed).toBe(false);
    expect(outcome?.failedRuleCode).toBe('RULE_ACTIVITY_WINDOW_001');
  });

  // TC-3 (adapted — see this file's own header): a clause superficially shaped like a
  // resolver-dispatch clause but recognized by no registered resolver falls through safely.
  it('TC-3: a resolver-shaped clause no registered resolver recognizes is not-passed, logs a warning, never throws', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      let outcome: ReturnType<typeof evaluator.evaluate> | undefined;
      expect(() => {
        outcome = evaluator.evaluate(fakeRow({ tracker_component_code: 'COMP-UNKNOWN-RESOLVER' }), [
          rule({
            ruleCode: 'RULE_UNKNOWN_RESOLVER',
            expression: 'geoLocation within the :regionType boundary',
            boundValuesJson: '{"regionType":"APAC"}',
          }),
        ]);
      }).not.toThrow();

      expect(outcome?.passed).toBe(false);
      expect(outcome?.failedRuleCode).toBe('RULE_UNKNOWN_RESOLVER');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // An unsupported windowType is claimed by ScheduleContextResolver but reported unresolved —
  // not-passed, logged, never thrown (never invented behavior for an unseen windowType).
  it('an unsupported windowType is not-passed, logs a warning naming the resolver, never throws', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      let outcome: ReturnType<typeof evaluator.evaluate> | undefined;
      expect(() => {
        outcome = evaluator.evaluate(fakeRow(), [
          windowRule({
            boundValuesJson: '{"windowType":"WEEKLY","windowStart":"00:00","windowEnd":"23:59"}',
          }),
        ]);
      }).not.toThrow();

      expect(outcome?.passed).toBe(false);
      expect(outcome?.comment).toContain('SCHEDULE_CONTEXT');
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('SCHEDULE_CONTEXT'))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // TC-5: resolver dispatch on one rule never poisons a different, unrelated evaluate() call for
  // another row — same discipline T-RAP-063's own TC-5 already proved for the placeholder path.
  it('TC-5: an unresolvable resolver-backed rule does not affect an independent, resolvable evaluation', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const unresolved = evaluator.evaluate(fakeRow(), [
        windowRule({ boundValuesJson: '{"windowType":"WEEKLY"}' }),
      ]);
      expect(unresolved.passed).toBe(false);

      const resolvable = evaluator.evaluate(fakeRow({ activity_value: '10.0000' }), [
        rule({ ruleCode: 'RULE_FINE', expression: 'activity.activity_value >= 1' }),
      ]);
      expect(resolvable.passed).toBe(true);

      const mixed = evaluator.evaluate(fakeRow(), [
        rule({ ruleCode: 'RULE_FINE_2', expression: 'activity.activity_value >= 1' }),
        windowRule(),
      ]);
      expect(mixed.passed).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // A rule combining a normal comparison clause with a resolver-backed clause (&&) — both must
  // pass, in either order, exactly like Phase 1's own compound-expression semantics.
  it('a compound (&&) expression combining a normal clause and a resolver-backed clause: both must pass', () => {
    const passing = evaluator.evaluate(
      fakeRow({
        activity_value: '50.0000',
        activity_performed_date: new Date('2026-01-01T12:00:00.000Z'),
      }),
      [
        windowRule({
          expression: 'activity.activity_value >= 10 && currentTime within the :windowType window',
          boundValuesJson: '{"windowType":"DAILY_HOURS","windowStart":"09:00","windowEnd":"17:00"}',
        }),
      ],
    );
    expect(passing.passed).toBe(true);

    const failingOnResolver = evaluator.evaluate(
      fakeRow({
        activity_value: '50.0000',
        activity_performed_date: new Date('2026-01-01T20:00:00.000Z'),
      }),
      [
        windowRule({
          expression: 'activity.activity_value >= 10 && currentTime within the :windowType window',
          boundValuesJson: '{"windowType":"DAILY_HOURS","windowStart":"09:00","windowEnd":"17:00"}',
        }),
      ],
    );
    expect(failingOnResolver.passed).toBe(false);

    const failingOnCondition = evaluator.evaluate(
      fakeRow({
        activity_value: '1.0000',
        activity_performed_date: new Date('2026-01-01T12:00:00.000Z'),
      }),
      [
        windowRule({
          expression: 'activity.activity_value >= 10 && currentTime within the :windowType window',
          boundValuesJson: '{"windowType":"DAILY_HOURS","windowStart":"09:00","windowEnd":"17:00"}',
        }),
      ],
    );
    expect(failingOnCondition.passed).toBe(false);
  });

  // TC-6 (evaluator half of this task's own determinism guarantee): the same row+rule evaluated
  // twice via the resolver path produces the identical outcome.
  it('the same row+resolver-backed rule evaluated twice yields the identical outcome', () => {
    const row = fakeRow();
    const ruleRefs = [windowRule()];
    expect(evaluator.evaluate(row, ruleRefs)).toEqual(evaluator.evaluate(row, ruleRefs));
  });
});
