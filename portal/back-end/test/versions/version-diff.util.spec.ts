/**
 * T-041 — pure-function tests for `version-diff.util.ts` (implementation notes 8/9, TC-25/TC-26).
 */
import {
  diffFlatObjectKeys,
  diffRuleParameterFields,
  suggestIsBreaking,
} from '@/modules/versions/version-diff.util';

describe('diffRuleParameterFields (TC-25)', () => {
  it('detects an added field', () => {
    const before = { fields: [{ key: 'minSpend', type: 'number' }] };
    const after = {
      fields: [
        { key: 'minSpend', type: 'number' },
        { key: 'tier', type: 'select' },
      ],
    };
    expect(diffRuleParameterFields(before, after)).toEqual({
      added: ['tier'],
      removed: [],
      typeChanged: [],
    });
  });

  it('detects a removed field (TC-26)', () => {
    const before = {
      fields: [
        { key: 'minSpend', type: 'number' },
        { key: 'tier', type: 'select' },
      ],
    };
    const after = { fields: [{ key: 'minSpend', type: 'number' }] };
    const diff = diffRuleParameterFields(before, after);
    expect(diff.removed).toEqual(['tier']);
    expect(suggestIsBreaking(diff)).toBe(true);
  });

  it('detects a type change', () => {
    const before = { fields: [{ key: 'minSpend', type: 'number' }] };
    const after = { fields: [{ key: 'minSpend', type: 'string' }] };
    const diff = diffRuleParameterFields(before, after);
    expect(diff.typeChanged).toEqual(['minSpend']);
    expect(suggestIsBreaking(diff)).toBe(true);
  });

  it('a purely additive change is not suggested as breaking', () => {
    const before = { fields: [{ key: 'minSpend', type: 'number' }] };
    const after = {
      fields: [
        { key: 'minSpend', type: 'number' },
        { key: 'tier', type: 'select' },
      ],
    };
    expect(suggestIsBreaking(diffRuleParameterFields(before, after))).toBe(false);
  });

  it('tolerates malformed/absent parameters — never throws', () => {
    expect(diffRuleParameterFields(null, undefined)).toEqual({
      added: [],
      removed: [],
      typeChanged: [],
    });
    expect(diffRuleParameterFields({ fields: 'not-an-array' }, { fields: [] })).toEqual({
      added: [],
      removed: [],
      typeChanged: [],
    });
  });

  it('no change → empty diff, not breaking', () => {
    const params = { fields: [{ key: 'minSpend', type: 'number' }] };
    const diff = diffRuleParameterFields(params, params);
    expect(diff).toEqual({ added: [], removed: [], typeChanged: [] });
    expect(suggestIsBreaking(diff)).toBe(false);
  });
});

describe('diffFlatObjectKeys (reward connectorConfig mapping)', () => {
  it('detects added/removed/type-changed top-level keys', () => {
    const before = { apiKey: 'abc', timeout: 30 };
    const after = { apiKey: 123, endpoint: 'https://x' };
    expect(diffFlatObjectKeys(before, after)).toEqual({
      added: ['endpoint'],
      removed: ['timeout'],
      typeChanged: ['apiKey'],
    });
  });

  it('treats a missing side as an empty object', () => {
    expect(diffFlatObjectKeys(null, { a: 1 })).toEqual({
      added: ['a'],
      removed: [],
      typeChanged: [],
    });
    expect(diffFlatObjectKeys({ a: 1 }, undefined)).toEqual({
      added: [],
      removed: ['a'],
      typeChanged: [],
    });
  });
});
