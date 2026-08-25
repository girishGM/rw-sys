import { isRuleCode, isRuleParameters } from '@/modules/rules/rules.validators';

describe('isRuleCode', () => {
  it.each(['MIN_SPEND_TIER', 'X1', 'FOO_BAR_9'])('accepts %s', (value) => {
    expect(isRuleCode(value)).toBe(true);
  });

  it('rejects a single character (the pattern requires at least 2)', () => {
    expect(isRuleCode('A')).toBe(false);
  });

  it.each([
    ['lowercase', 'min_spend'],
    ['leading digit', '1FOO'],
    ['spaces', 'MIN SPEND'],
    ['punctuation', 'MIN-SPEND'],
    ['empty', ''],
    ['non-string', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isRuleCode(value)).toBe(false);
  });
});

describe('isRuleParameters', () => {
  it('accepts an empty field list', () => {
    expect(isRuleParameters({ fields: [] })).toBe(true);
  });

  it('accepts a well-formed field list', () => {
    expect(
      isRuleParameters({
        fields: [
          { key: 'minSpend', label: 'Minimum spend', type: 'number', required: true, min: 0 },
          {
            key: 'tier',
            label: 'Tier',
            type: 'select',
            required: false,
            options: ['gold', 'silver'],
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects a select field with no options', () => {
    expect(
      isRuleParameters({
        fields: [{ key: 'tier', label: 'Tier', type: 'select', required: true }],
      }),
    ).toBe(false);
  });

  it('rejects duplicate keys', () => {
    expect(
      isRuleParameters({
        fields: [
          { key: 'a', label: 'A', type: 'string', required: true },
          { key: 'a', label: 'A again', type: 'string', required: false },
        ],
      }),
    ).toBe(false);
  });

  it('rejects an unrecognised extra key (.strict())', () => {
    expect(isRuleParameters({ fields: [], extra: true })).toBe(false);
  });

  it('rejects a malformed key', () => {
    expect(
      isRuleParameters({
        fields: [{ key: 'not a key!', label: 'x', type: 'string', required: true }],
      }),
    ).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isRuleParameters(null)).toBe(false);
    expect(isRuleParameters('not json')).toBe(false);
    expect(isRuleParameters(42)).toBe(false);
    expect(isRuleParameters([])).toBe(false);
  });
});
