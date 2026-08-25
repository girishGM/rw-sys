import {
  isRewardConnectorConfig,
  isRewardPolicyCode,
  isRewardSystemCode,
} from '@/modules/rewards/rewards.validators';

describe('isRewardSystemCode', () => {
  it.each(['CASHBACK_STANDARD', 'X1', 'FOO_BAR_9'])('accepts %s', (value) => {
    expect(isRewardSystemCode(value)).toBe(true);
  });

  it('rejects a single character (the pattern requires at least 2)', () => {
    expect(isRewardSystemCode('A')).toBe(false);
  });

  it.each([
    ['lowercase', 'cashback'],
    ['leading digit', '1FOO'],
    ['spaces', 'CASH BACK'],
    ['punctuation', 'CASH-BACK'],
    ['empty', ''],
    ['non-string', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isRewardSystemCode(value)).toBe(false);
  });
});

describe('isRewardPolicyCode', () => {
  it.each(['STANDARD', 'X1'])('accepts %s', (value) => {
    expect(isRewardPolicyCode(value)).toBe(true);
  });

  it('rejects a single character', () => {
    expect(isRewardPolicyCode('A')).toBe(false);
  });

  it.each([
    ['lowercase', 'standard'],
    ['spaces', 'STD ARD'],
    ['non-string', 42],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isRewardPolicyCode(value)).toBe(false);
  });
});

describe('isRewardConnectorConfig', () => {
  it('accepts undefined (an omitted field)', () => {
    expect(isRewardConnectorConfig(undefined)).toBe(true);
  });

  it('accepts a flat object of string/number/boolean values', () => {
    expect(
      isRewardConnectorConfig({ apiKey: 'sk_live_1234', timeoutMs: 5000, retryOnFail: true }),
    ).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(isRewardConnectorConfig({})).toBe(true);
  });

  it('rejects a nested object value', () => {
    expect(isRewardConnectorConfig({ nested: { a: 1 } })).toBe(false);
  });

  it('rejects more than the maximum number of keys', () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 31; i += 1) tooMany[`key${String(i)}`] = 'v';
    expect(isRewardConnectorConfig(tooMany)).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isRewardConnectorConfig(null)).toBe(false);
    expect(isRewardConnectorConfig('not json')).toBe(false);
    expect(isRewardConnectorConfig(42)).toBe(false);
    expect(isRewardConnectorConfig([])).toBe(false);
  });
});
