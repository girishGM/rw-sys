/**
 * T-038 TC-19 / TC-20 — `buildApprovalDiff`.
 *
 * The whole specification of this function is *"it cannot throw"* (implementation note 7:
 * *"malformed payload → a readable 'cannot render diff' state, never a crash on a checker's
 * queue"*), so the negative cases below are not edge-case padding — they are the feature. Every
 * shape a `jsonb` column can legally hold is fed in, and the assertion in each case is that a
 * value came back describing the problem.
 *
 * A pure function of two arguments, so this needs no database, no Nest container and no request —
 * the same shape `test/campaigns/structural-validation.spec.ts` (T-037) uses for the same reason.
 */
import { buildApprovalDiff, type DiffSubject } from '@/modules/approvals/approval-diff';

const SUBJECT: DiffSubject = {
  campaignCode: 'T038_CODE',
  name: 'Raya bonus',
  startDate: new Date('2026-03-01T00:00:00.000Z'),
  endDate: new Date('2026-03-31T00:00:00.000Z'),
};

/** What `CampaignsService.submit` actually writes, matching {@link SUBJECT} exactly — calendar
 * dates since T-065, which is why these are sliced to ten characters. */
function payloadMatching(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignCode: SUBJECT.campaignCode,
    name: SUBJECT.name,
    startDate: SUBJECT.startDate.toISOString().slice(0, 10),
    endDate: SUBJECT.endDate.toISOString().slice(0, 10),
    budgets: [],
    warnings: [],
    trackerCount: 1,
    componentCount: 2,
    ...overrides,
  };
}

describe('T-038 · buildApprovalDiff — TC-19: changed fields only', () => {
  it('reports nothing changed when the campaign is untouched since submission', () => {
    const diff = buildApprovalDiff(payloadMatching(), SUBJECT);

    expect(diff.renderable).toBe(true);
    expect(diff.problem).toBeNull();
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(4);
    expect(diff.skippedFields).toEqual([]);
  });

  it('reports only the fields that actually differ, with before and after', () => {
    const diff = buildApprovalDiff(payloadMatching({ name: 'Raya bonus (old)' }), SUBJECT);

    expect(diff.changed).toEqual([
      { field: 'name', label: 'Name', before: 'Raya bonus (old)', after: 'Raya bonus' },
    ]);
    // The other three matched, so they are counted rather than listed.
    expect(diff.unchangedCount).toBe(3);
  });

  it.each([
    // A payload written before T-065, in `toISOString()`'s `Z` form...
    '2026-03-01T00:00:00.000Z',
    // ...one written by a maker's own browser offset, which is what the pre-fix wizard sent...
    '2026-03-01T08:00:00.000+08:00',
    // ...one whose UTC instant lands on the *previous* day, which the pre-fix wizard also sent
    // (`<day>T00:00:00-05:00`) and which a textual or instant comparison calls a change...
    '2026-03-01T00:00:00.000-05:00',
    // ...and the calendar form written since.
    '2026-03-01',
  ])('treats %s as the same day as the stored 2026-03-01, not a change', (submitted) => {
    // T-065 — the days are compared, never the text and never the instants. Every form above is
    // the 1st of March; a diff that called any of them a change would put a spurious row in front
    // of a checker, which is the fastest way to teach them to ignore the diff entirely.
    const diff = buildApprovalDiff(payloadMatching({ startDate: submitted }), SUBJECT);

    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(4);
  });

  it('TC-7: shows a genuinely changed date as a calendar day on both sides', () => {
    // What the checker reads must be the same string the maker saw in the wizard — an instant
    // here would ask them to approve a date in a format the campaign screen never showed.
    const diff = buildApprovalDiff(payloadMatching({ endDate: '2026-03-20' }), SUBJECT);

    expect(diff.changed).toEqual([
      { field: 'endDate', label: 'End date', before: '2026-03-20', after: '2026-03-31' },
    ]);
  });

  it('falls back to textual comparison when neither side parses as a date', () => {
    const diff = buildApprovalDiff(payloadMatching({ startDate: 'not-a-date' }), SUBJECT);

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ field: 'startDate', before: 'not-a-date' });
  });

  it('carries the submission-time budget context through untouched', () => {
    const diff = buildApprovalDiff(
      payloadMatching({
        budgets: [
          {
            unitType: 'currency',
            unitCode: 'MYR',
            campaignBudget: '100000.00',
            maxCampaignBudget: '500000.00',
            percentOfCeiling: 20,
            state: 'ok',
          },
        ],
        warnings: ['UNBUDGETED_REWARD_UNIT'],
      }),
      SUBJECT,
    );

    // T-037 implementation note 18 put `percentOfCeiling` in the payload so a checker sees an
    // unusual number without doing arithmetic; carrying it through is the reason it was written.
    expect(diff.budgets).toEqual([
      {
        unitType: 'currency',
        unitCode: 'MYR',
        campaignBudget: '100000.00',
        maxCampaignBudget: '500000.00',
        percentOfCeiling: 20,
        state: 'ok',
      },
    ]);
    expect(diff.warnings).toEqual(['UNBUDGETED_REWARD_UNIT']);
    expect(diff.trackerCount).toBe(1);
    expect(diff.componentCount).toBe(2);
  });
});

describe('T-038 · buildApprovalDiff — TC-20: a malformed payload never crashes the queue', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('reports PAYLOAD_MISSING for %s', (_label, payload) => {
    const diff = buildApprovalDiff(payload, SUBJECT);

    expect(diff.renderable).toBe(false);
    expect(diff.problem).toBe('PAYLOAD_MISSING');
    expect(diff.changed).toEqual([]);
  });

  it.each([
    ['a number', 42],
    ['a string', 'not an object'],
    ['a boolean', true],
    ['an array', [1, 2, 3]],
  ])('reports PAYLOAD_NOT_AN_OBJECT for %s', (_label, payload) => {
    const diff = buildApprovalDiff(payload, SUBJECT);

    expect(diff.renderable).toBe(false);
    expect(diff.problem).toBe('PAYLOAD_NOT_AN_OBJECT');
  });

  it('reports SUBJECT_UNAVAILABLE, but still shows the payload context, when the campaign is gone', () => {
    const diff = buildApprovalDiff(payloadMatching({ trackerCount: 3 }), null);

    expect(diff.renderable).toBe(false);
    expect(diff.problem).toBe('SUBJECT_UNAVAILABLE');
    // The request row is still governance evidence and must remain readable.
    expect(diff.trackerCount).toBe(3);
  });

  it('skips a field whose value has an uncomparable type rather than inventing a change', () => {
    const diff = buildApprovalDiff(payloadMatching({ name: 12345, campaignCode: null }), SUBJECT);

    expect(diff.renderable).toBe(true);
    expect(diff.skippedFields).toEqual(expect.arrayContaining(['name', 'campaignCode']));
    expect(diff.changed.map((entry) => entry.field)).not.toContain('name');
  });

  it('skips a field that is absent from the payload entirely', () => {
    const payload = payloadMatching();
    delete payload['endDate'];

    const diff = buildApprovalDiff(payload, SUBJECT);

    expect(diff.skippedFields).toEqual(['endDate']);
    expect(diff.unchangedCount).toBe(3);
  });

  it('drops a budget line with no unit rather than labelling it with an invented one', () => {
    const diff = buildApprovalDiff(
      payloadMatching({
        budgets: [
          { unitCode: 'MYR' },
          null,
          'nonsense',
          ['also nonsense'],
          { unitType: 'points', unitCode: 'PTS' },
        ],
      }),
      SUBJECT,
    );

    expect(diff.budgets).toEqual([
      {
        unitType: 'points',
        unitCode: 'PTS',
        campaignBudget: '0',
        maxCampaignBudget: null,
        percentOfCeiling: null,
        state: 'unknown',
      },
    ]);
  });

  it('ignores non-array and non-string context values instead of failing', () => {
    const diff = buildApprovalDiff(
      payloadMatching({
        budgets: 'not an array',
        warnings: [1, 'REAL_WARNING', null],
        trackerCount: 1.5,
        componentCount: 'two',
      }),
      SUBJECT,
    );

    expect(diff.budgets).toEqual([]);
    expect(diff.warnings).toEqual(['REAL_WARNING']);
    expect(diff.trackerCount).toBeNull();
    expect(diff.componentCount).toBeNull();
  });

  it('never throws, for any of the shapes a jsonb column can hold', () => {
    const shapes: unknown[] = [
      null,
      undefined,
      0,
      '',
      false,
      [],
      {},
      { campaignCode: {} },
      { budgets: [{}] },
      { warnings: {} },
      new Date(),
    ];

    for (const shape of shapes) {
      expect(() => buildApprovalDiff(shape, SUBJECT)).not.toThrow();
      expect(() => buildApprovalDiff(shape, null)).not.toThrow();
    }
  });
});
