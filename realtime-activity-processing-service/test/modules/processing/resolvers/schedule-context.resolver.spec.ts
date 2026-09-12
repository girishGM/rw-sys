/**
 * T-RAP-064 (Phase 2). Pure unit tests for `ScheduleContextResolver` — no DB, no registry, no
 * `RuleEvaluatorService` (that wiring is covered by
 * `rule-evaluator.service.resolver-dispatch.spec.ts`, alongside this file).
 *
 * **Path note (deviation from the task file's own listed path).** The task file names this file
 * `test/processing/resolvers/schedule-context.resolver.spec.ts`, but this repo's own established
 * convention (`realtime-activity-processing-service/CLAUDE.md`'s "Testing conventions" — a
 * mirrored `test/` tree under `test/modules/*`, matching every existing directory here) and this
 * task's own real, granted file scope
 * (`realtime-activity-processing-service-plan/project.config.json`'s `agent-rap-processing` entry
 * — `test/modules/processing/**`, not `test/processing/**`, which doesn't exist anywhere else in
 * this codebase) both point at `test/modules/processing/resolvers/` instead. See this task's own
 * completion report for the full note.
 */
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import {
  ScheduleContextResolver,
  SCHEDULE_CONTEXT_RESOLVER_CODE,
} from '@/modules/processing/resolvers/schedule-context.resolver';
import type { RuleResolverContext } from '@/modules/processing/resolvers/rule-resolver.interface';

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
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
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

const REAL_CLAUSE = 'currentTime within the :windowType window';

function context(overrides: Partial<RuleResolverContext> = {}): RuleResolverContext {
  return {
    clause: REAL_CLAUSE,
    boundValues: { windowType: 'DAILY_HOURS', windowStart: '00:00', windowEnd: '23:59' },
    row: fakeRow(),
    ...overrides,
  };
}

describe('ScheduleContextResolver', () => {
  const resolver = new ScheduleContextResolver();

  it('resolverCode is SCHEDULE_CONTEXT (matches the portal registry naming convention)', () => {
    expect(resolver.resolverCode).toBe(SCHEDULE_CONTEXT_RESOLVER_CODE);
  });

  describe('canHandle', () => {
    it('recognizes the real "currentTime within the :windowType window" clause shape', () => {
      expect(resolver.canHandle(REAL_CLAUSE)).toBe(true);
    });

    it('recognizes the shape with surrounding whitespace', () => {
      expect(resolver.canHandle(`  ${REAL_CLAUSE}  `)).toBe(true);
    });

    it('is case-insensitive for the "within the ... window" phrasing', () => {
      expect(resolver.canHandle('currentTime WITHIN THE :windowType WINDOW')).toBe(true);
    });

    it('does not claim an ordinary activity.<field> <op> <literal> clause', () => {
      expect(resolver.canHandle('activity.activity_value >= 1')).toBe(false);
    });

    it('does not claim the :operator-shaped RULE_ACTIVITY_VALUE_001 clause', () => {
      expect(
        resolver.canHandle(
          'transaction.amount :operator :value (transaction.currency == :currency)',
        ),
      ).toBe(false);
    });
  });

  describe('resolve — TC-1: activity timestamp inside the configured window', () => {
    it('a full-day DAILY_HOURS window (the one real live case) always passes', () => {
      const outcome = resolver.resolve(context());
      expect(outcome).toEqual({ resolved: true, passed: true });
    });

    it('a narrower DAILY_HOURS window: an activity time inside it passes', () => {
      const outcome = resolver.resolve(
        context({
          boundValues: { windowType: 'DAILY_HOURS', windowStart: '09:00', windowEnd: '17:00' },
          row: fakeRow({ activity_performed_date: new Date('2026-01-01T12:30:00.000Z') }),
        }),
      );
      expect(outcome).toEqual({ resolved: true, passed: true });
    });

    it('an activity exactly on the window boundary (inclusive) passes', () => {
      const outcome = resolver.resolve(
        context({
          boundValues: { windowType: 'DAILY_HOURS', windowStart: '09:00', windowEnd: '17:00' },
          row: fakeRow({ activity_performed_date: new Date('2026-01-01T17:00:00.000Z') }),
        }),
      );
      expect(outcome).toEqual({ resolved: true, passed: true });
    });
  });

  describe('resolve — TC-2: activity timestamp outside the configured window', () => {
    it('an activity time outside a narrow DAILY_HOURS window: passed=false, never throws', () => {
      let outcome;
      expect(() => {
        outcome = resolver.resolve(
          context({
            boundValues: { windowType: 'DAILY_HOURS', windowStart: '09:00', windowEnd: '17:00' },
            row: fakeRow({ activity_performed_date: new Date('2026-01-01T20:00:00.000Z') }),
          }),
        );
      }).not.toThrow();
      expect(outcome).toEqual({ resolved: true, passed: false });
    });

    it('an overnight (wraparound) window is evaluated correctly: inside the wrapped range', () => {
      const outcome = resolver.resolve(
        context({
          boundValues: { windowType: 'DAILY_HOURS', windowStart: '22:00', windowEnd: '06:00' },
          row: fakeRow({ activity_performed_date: new Date('2026-01-01T02:00:00.000Z') }),
        }),
      );
      expect(outcome).toEqual({ resolved: true, passed: true });
    });

    it('an overnight (wraparound) window is evaluated correctly: outside the wrapped range', () => {
      const outcome = resolver.resolve(
        context({
          boundValues: { windowType: 'DAILY_HOURS', windowStart: '22:00', windowEnd: '06:00' },
          row: fakeRow({ activity_performed_date: new Date('2026-01-01T12:00:00.000Z') }),
        }),
      );
      expect(outcome).toEqual({ resolved: true, passed: false });
    });
  });

  describe('resolve — never invents behavior for an unsupported/malformed configuration', () => {
    it('an unsupported windowType is reported as unresolved, never guessed', () => {
      const outcome = resolver.resolve(
        context({
          boundValues: { windowType: 'WEEKLY', windowStart: '00:00', windowEnd: '23:59' },
        }),
      );
      expect(outcome.resolved).toBe(false);
      expect(outcome.reason).toContain('WEEKLY');
    });

    it('a missing windowType is reported as unresolved', () => {
      const outcome = resolver.resolve(context({ boundValues: {} }));
      expect(outcome.resolved).toBe(false);
    });

    it('a malformed windowStart/windowEnd is reported as unresolved', () => {
      const outcome = resolver.resolve(
        context({
          boundValues: { windowType: 'DAILY_HOURS', windowStart: 'not-a-time', windowEnd: '23:59' },
        }),
      );
      expect(outcome.resolved).toBe(false);
      expect(outcome.reason).toContain('windowStart');
    });

    it('an unknown field token (not "currentTime") is reported as unresolved, never guessed', () => {
      const outcome = resolver.resolve(
        context({ clause: 'someOtherField within the :windowType window' }),
      );
      expect(outcome.resolved).toBe(false);
      expect(outcome.reason).toContain('someOtherField');
    });

    it('never throws for any of the above — always reports resolved:false instead', () => {
      expect(() =>
        resolver.resolve(context({ boundValues: { windowType: 'NOT_REAL' } })),
      ).not.toThrow();
      expect(() =>
        resolver.resolve(context({ clause: 'nonsense within the :windowType window' })),
      ).not.toThrow();
    });
  });
});
