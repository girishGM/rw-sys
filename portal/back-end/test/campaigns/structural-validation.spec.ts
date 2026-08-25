/**
 * T-037 implementation note 19 — the pre-submit structural check.
 *
 * TC-21i and TC-21j are the two the task file singles out (*"the two structural traps"* alongside
 * TC-21e), and TC-21o is the one that decides whether a campaign can pay anything at all.
 */
import {
  structuralIssueDetails,
  validateStructure,
  type ComponentShape,
  type StructureInput,
  type TrackerShape,
} from '@/modules/campaigns/structural-validation';
import type { RuleParameters } from '@reward-portal/shared';

const NO_PARAMETERS: RuleParameters = { fields: [] };

const REQUIRES_MIN_SPEND: RuleParameters = {
  fields: [
    { key: 'minSpend', label: 'Minimum spend', type: 'number', required: true, min: 0 },
    { key: 'note', label: 'Note', type: 'string', required: false },
  ],
};

function component(overrides: Partial<ComponentShape> = {}): ComponentShape {
  return {
    id: 100,
    activityId: 9,
    rules: [{ parameters: NO_PARAMETERS, values: {} }],
    ...overrides,
  };
}

function tracker(overrides: Partial<TrackerShape> = {}): TrackerShape {
  return {
    id: 10,
    completionLogic: 'all',
    completionThreshold: null,
    componentIds: [100],
    ...overrides,
  };
}

function input(overrides: Partial<StructureInput> = {}): StructureInput {
  return {
    trackers: [tracker()],
    components: [component()],
    merchantCount: 1,
    rewardCount: 1,
    ...overrides,
  };
}

function codes(issues: readonly { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

describe('T-037 structural validation', () => {
  it('accepts a complete campaign', () => {
    expect(validateStructure(input())).toEqual([]);
  });

  it('TC-21j: a tracker with no components cannot complete', () => {
    const issues = validateStructure(
      input({ trackers: [tracker({ componentIds: [] })], components: [] }),
    );
    expect(codes(issues)).toContain('TRACKER_HAS_NO_COMPONENT');
    expect(issues.find((issue) => issue.code === 'TRACKER_HAS_NO_COMPONENT')?.trackerId).toBe(10);
  });

  it('TC-21i: a component with no rule can never complete', () => {
    const issues = validateStructure(input({ components: [component({ rules: [] })] }));
    const issue = issues.find((entry) => entry.code === 'COMPONENT_HAS_NO_RULE');
    expect(issue).toMatchObject({ trackerId: 10, componentId: 100 });
  });

  it('TC-21o: a campaign with no reward at any level cannot pay out', () => {
    expect(codes(validateStructure(input({ rewardCount: 0 })))).toContain('CAMPAIGN_HAS_NO_REWARD');
  });

  it('reports a campaign with no trackers', () => {
    expect(codes(validateStructure(input({ trackers: [], components: [] })))).toContain(
      'CAMPAIGN_HAS_NO_TRACKER',
    );
  });

  it('reports a campaign with no merchants, rather than one "activity not offered" per component', () => {
    const issues = validateStructure(input({ merchantCount: 0 }));
    expect(codes(issues)).toContain('CAMPAIGN_HAS_NO_MERCHANT');
  });

  it('reports a component with no activity', () => {
    const issues = validateStructure(input({ components: [component({ activityId: null })] }));
    expect(codes(issues)).toContain('COMPONENT_HAS_NO_ACTIVITY');
  });

  describe('TC-21e — the n_of threshold', () => {
    it('accepts a threshold inside the component count', () => {
      const issues = validateStructure(
        input({
          trackers: [
            tracker({
              completionLogic: 'n_of',
              completionThreshold: 2,
              componentIds: [100, 101, 102],
            }),
          ],
          components: [component({ id: 100 }), component({ id: 101 }), component({ id: 102 })],
        }),
      );
      expect(codes(issues)).not.toContain('THRESHOLD_ABOVE_COMPONENT_COUNT');
    });

    it('rejects 4 of 3', () => {
      const issues = validateStructure(
        input({
          trackers: [
            tracker({
              completionLogic: 'n_of',
              completionThreshold: 4,
              componentIds: [100, 101, 102],
            }),
          ],
          components: [component({ id: 100 }), component({ id: 101 }), component({ id: 102 })],
        }),
      );
      expect(codes(issues)).toContain('THRESHOLD_ABOVE_COMPONENT_COUNT');
    });

    it('TC-21f: rejects a threshold of zero', () => {
      const issues = validateStructure(
        input({ trackers: [tracker({ completionLogic: 'n_of', completionThreshold: 0 })] }),
      );
      expect(codes(issues)).toContain('THRESHOLD_ABOVE_COMPONENT_COUNT');
    });

    it('rejects n_of with no threshold at all', () => {
      const issues = validateStructure(
        input({ trackers: [tracker({ completionLogic: 'n_of', completionThreshold: null })] }),
      );
      expect(codes(issues)).toContain('THRESHOLD_ABOVE_COMPONENT_COUNT');
    });

    it('ignores a stale threshold on an "all" tracker', () => {
      const issues = validateStructure(
        input({ trackers: [tracker({ completionLogic: 'all', completionThreshold: 99 })] }),
      );
      expect(codes(issues)).not.toContain('THRESHOLD_ABOVE_COMPONENT_COUNT');
    });
  });

  describe('rule parameter completeness', () => {
    it('accepts a binding whose required values are all supplied', () => {
      const issues = validateStructure(
        input({
          components: [
            component({ rules: [{ parameters: REQUIRES_MIN_SPEND, values: { minSpend: 50 } }] }),
          ],
        }),
      );
      expect(codes(issues)).not.toContain('RULE_VALUES_INCOMPLETE');
    });

    it('flags a binding missing a required value — a rule can gain one in a later version', () => {
      const issues = validateStructure(
        input({
          components: [component({ rules: [{ parameters: REQUIRES_MIN_SPEND, values: {} }] })],
        }),
      );
      expect(codes(issues)).toContain('RULE_VALUES_INCOMPLETE');
    });

    it('does not require optional values', () => {
      const issues = validateStructure(
        input({
          components: [
            component({ rules: [{ parameters: REQUIRES_MIN_SPEND, values: { minSpend: 0 } }] }),
          ],
        }),
      );
      expect(codes(issues)).not.toContain('RULE_VALUES_INCOMPLETE');
    });
  });

  it('reports every problem at once, so step 7 needs one round trip rather than five', () => {
    const issues = validateStructure({
      trackers: [tracker({ completionLogic: 'n_of', completionThreshold: 9 })],
      components: [component({ activityId: null, rules: [] })],
      merchantCount: 0,
      rewardCount: 0,
    });
    expect(codes(issues)).toEqual(
      expect.arrayContaining([
        'CAMPAIGN_HAS_NO_MERCHANT',
        'CAMPAIGN_HAS_NO_REWARD',
        'THRESHOLD_ABOVE_COMPONENT_COUNT',
        'COMPONENT_HAS_NO_ACTIVITY',
        'COMPONENT_HAS_NO_RULE',
      ]),
    );
  });

  it('skips a component id the tracker names but which no longer exists, rather than crashing', () => {
    const issues = validateStructure(
      input({ trackers: [tracker({ componentIds: [100, 999] })], components: [component()] }),
    );
    expect(codes(issues)).toEqual([]);
  });

  describe('structuralIssueDetails', () => {
    it('names the most specific field each issue concerns', () => {
      const details = structuralIssueDetails([
        { code: 'CAMPAIGN_HAS_NO_REWARD', trackerId: null, componentId: null },
        { code: 'TRACKER_HAS_NO_COMPONENT', trackerId: 10, componentId: null },
        { code: 'COMPONENT_HAS_NO_RULE', trackerId: 10, componentId: 100 },
      ]);
      expect(details).toEqual([
        { field: 'campaignId', code: 'CAMPAIGN_HAS_NO_REWARD' },
        { field: 'trackerId', code: 'TRACKER_HAS_NO_COMPONENT' },
        { field: 'componentId', code: 'COMPONENT_HAS_NO_RULE' },
      ]);
    });

    it('produces codes that satisfy the response-body safety pattern', () => {
      // `app-error.ts`'s `SAFE_ERROR_CODE_PATTERN`: nothing a client receives is derived from the
      // text of an error, and these have to survive that filter to reach the maker at all.
      const details = structuralIssueDetails([
        { code: 'RULE_VALUES_INCOMPLETE', trackerId: 1, componentId: 2 },
      ]);
      for (const detail of details) {
        expect(detail.code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
        expect(detail.field).toMatch(/^[A-Za-z_][A-Za-z0-9_.[\]]{0,79}$/);
      }
    });
  });
});
