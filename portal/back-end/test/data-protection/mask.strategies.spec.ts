/**
 * T-017 — the five mask strategies of 07-DATA-PROTECTION.md §7, and the `hash` treatment.
 *
 * The examples in §7's table are asserted **verbatim**, because they are the specification: if a
 * future change makes `maskEmail` emit `jo•••@example.com` that is a different contract, and the
 * SPA's column widths and every operator's pattern-matching habit are built on the old one.
 *
 * The rest of the file is boundary work, and all of it exists for one reason: a mask that
 * degrades to plaintext on a short input is worse than no mask, because it looks like it works.
 */
import {
  applyMask,
  hashForLog,
  isMaskStrategy,
  maskEmail,
  maskFirstLast,
  maskFull,
  maskLast4,
  maskPhone,
} from '@/common/data-protection/mask.strategies';
import {
  FULL_MASK_LENGTH,
  HASH_PREFIX,
  MASK_CHAR,
} from '@/common/data-protection/data-protection.constants';

const EMAIL = 'john.doe@example.com';
const PHONE = '+60123457788';

describe('§7 table, verbatim', () => {
  it('email', () => {
    expect(maskEmail(EMAIL)).toBe(`j${MASK_CHAR.repeat(4)}@example.com`);
  });

  it('phone', () => {
    expect(maskPhone(PHONE)).toBe(`${MASK_CHAR.repeat(7)}7788`);
  });

  it('last4 keeps the last four characters', () => {
    expect(maskLast4(EMAIL)).toBe(`${MASK_CHAR.repeat(EMAIL.length - 4)}.com`);
    expect(maskLast4(PHONE)).toBe(`${MASK_CHAR.repeat(PHONE.length - 4)}7788`);
  });

  it('first_last keeps the first and last character', () => {
    expect(maskFirstLast(EMAIL)).toBe(`j${MASK_CHAR.repeat(EMAIL.length - 2)}m`);
    expect(maskFirstLast(PHONE)).toBe(`+${MASK_CHAR.repeat(PHONE.length - 2)}8`);
  });

  it('full is a fixed width, so it never discloses the input length', () => {
    expect(maskFull()).toBe(MASK_CHAR.repeat(FULL_MASK_LENGTH));
    expect(applyMask('a', 'full')).toBe(applyMask('a'.repeat(400), 'full'));
  });
});

describe('short inputs never survive a mask', () => {
  it.each([
    ['maskEmail', maskEmail, ['@example.com', 'john@', 'nothing-at-all', '@', '']],
    ['maskPhone', maskPhone, ['', '1', '12', '123', '1234', 'no digits here']],
    ['maskLast4', maskLast4, ['', 'a', 'ab', 'abc', 'abcd']],
    ['maskFirstLast', maskFirstLast, ['', 'a', 'ab']],
  ] as [string, (value: string) => string, string[]][])('%s', (_name, fn, inputs) => {
    for (const input of inputs) {
      expect(fn(input)).toBe(maskFull());
    }
  });

  it('the character above each boundary is masked, not passed through', () => {
    // One character longer than the fallback threshold: the structure-preserving branch runs, and
    // it must still cover at least one character.
    expect(maskLast4('abcde')).toBe(`${MASK_CHAR}bcde`);
    expect(maskFirstLast('abc')).toBe(`a${MASK_CHAR}c`);
    expect(maskPhone('12345')).toBe(`${MASK_CHAR}2345`);
  });
});

describe('maskEmail', () => {
  it('splits on the LAST @, so a quoted local part cannot smuggle the domain out', () => {
    expect(maskEmail('a@b@example.com')).toBe(`a${MASK_CHAR.repeat(4)}@example.com`);
  });

  it('keeps the domain, which is the point of choosing this strategy', () => {
    expect(maskEmail('someone@sub.domain.co.uk')).toContain('@sub.domain.co.uk');
  });

  it('does not disclose the local part length', () => {
    expect(maskEmail('a@x.com')).toHaveLength(maskEmail('abcdefghij@x.com').length);
  });
});

describe('maskPhone', () => {
  it('drops the country code — a preserved +60 would identify the country of every number', () => {
    expect(maskPhone(PHONE)).not.toContain('+');
    expect(maskPhone(PHONE)).not.toContain('60');
  });

  it('normalises formatting, so the same number masks identically however it was written', () => {
    expect(maskPhone('+60 12-345 7788')).toBe(maskPhone('(+60)123457788'));
  });
});

describe('hashForLog', () => {
  it('is stable and prefixed', () => {
    expect(hashForLog(EMAIL)).toBe(hashForLog(EMAIL));
    expect(hashForLog(EMAIL).startsWith(HASH_PREFIX)).toBe(true);
  });

  it('discloses neither the value nor its length', () => {
    expect(hashForLog(EMAIL)).not.toContain('john');
    expect(hashForLog('a')).toHaveLength(hashForLog('a'.repeat(500)).length);
  });

  it('separates different inputs', () => {
    expect(hashForLog('a@x.com')).not.toBe(hashForLog('b@x.com'));
  });
});

describe('applyMask', () => {
  it('passes null and undefined through — masking an absent value would invent data', () => {
    expect(applyMask(null, 'email')).toBeNull();
    expect(applyMask(undefined, 'email')).toBeUndefined();
  });

  it('masks a non-string as full rather than stringifying it first', () => {
    expect(applyMask(12345678901234, 'last4')).toBe(maskFull());
    expect(applyMask({ secret: 1 }, 'first_last')).toBe(maskFull());
    expect(applyMask(true, 'email')).toBe(maskFull());
    expect(applyMask([1, 2], 'phone')).toBe(maskFull());
  });

  it('masks as full when the strategy is unknown, missing or null', () => {
    expect(applyMask(EMAIL, 'nonsense' as never)).toBe(maskFull());
    expect(applyMask(EMAIL, null)).toBe(maskFull());
    expect(applyMask(EMAIL, undefined)).toBe(maskFull());
  });

  it('dispatches to every named strategy', () => {
    expect(applyMask(EMAIL, 'email')).toBe(maskEmail(EMAIL));
    expect(applyMask(PHONE, 'phone')).toBe(maskPhone(PHONE));
    expect(applyMask(EMAIL, 'last4')).toBe(maskLast4(EMAIL));
    expect(applyMask(EMAIL, 'first_last')).toBe(maskFirstLast(EMAIL));
    expect(applyMask(EMAIL, 'full')).toBe(maskFull());
  });
});

describe('isMaskStrategy', () => {
  it('accepts exactly the five §7 names', () => {
    for (const name of ['email', 'phone', 'last4', 'first_last', 'full']) {
      expect(isMaskStrategy(name)).toBe(true);
    }
  });

  it('rejects everything else, including non-strings', () => {
    for (const value of ['EMAIL', 'e-mail', '', null, undefined, 3, {}]) {
      expect(isMaskStrategy(value)).toBe(false);
    }
  });
});
