/**
 * T-037 — `decimal.util.ts`, the exact arithmetic every step-6 warning and the tenant-ceiling
 * gate are computed with.
 *
 * These are the cases that would be wrong if the module used `Number`. They are worth writing out
 * rather than trusting to `bigint`, because the *parsing* is where a decimal library usually goes
 * wrong, not the addition.
 */
import {
  daysBetween,
  format,
  multiplyByInteger,
  parse,
  percentOf,
  sum,
} from '@/modules/campaigns/decimal.util';

describe('T-037 decimal.util', () => {
  describe('parse', () => {
    it('reads a whole number as ten-thousandths', () => {
      expect(parse('500000')).toBe(5_000_000_000n);
    });

    it('reads every fractional width up to the column scale', () => {
      expect(parse('1.5')).toBe(15_000n);
      expect(parse('1.05')).toBe(10_500n);
      expect(parse('1.0005')).toBe(10_005n);
    });

    it('truncates beyond four places rather than rounding up', () => {
      // Toward zero, deliberately: rounding up could push a value past a ceiling it should not
      // have breached. See the function's own comment.
      expect(parse('1.00009')).toBe(10_000n);
    });

    it('handles a negative amount (headroom can go below zero)', () => {
      expect(parse('-1.5')).toBe(-15_000n);
    });

    it('returns null for anything that is not a plain decimal', () => {
      for (const value of ['', 'abc', '1e5', '+1', '1,000', ' ', '1.2.3']) {
        expect(parse(value)).toBeNull();
      }
    });

    it('returns null for null and undefined', () => {
      expect(parse(null)).toBeNull();
      expect(parse(undefined)).toBeNull();
    });

    it('tolerates surrounding whitespace', () => {
      expect(parse('  42  ')).toBe(420_000n);
    });
  });

  describe('format', () => {
    it('drops the fraction entirely when it is zero', () => {
      expect(format(5_000_000_000n)).toBe('500000');
    });

    it('trims trailing zeros but keeps significant places', () => {
      expect(format(15_000n)).toBe('1.5');
      expect(format(10_005n)).toBe('1.0005');
      expect(format(10_500n)).toBe('1.05');
    });

    it('renders zero as "0"', () => {
      expect(format(0n)).toBe('0');
    });

    it('renders a negative value with its sign', () => {
      expect(format(-15_000n)).toBe('-1.5');
    });

    it('round-trips every parseable value', () => {
      for (const value of ['0', '1', '1.5', '0.0001', '999999999999.9999']) {
        expect(format(parse(value) as bigint)).toBe(value === '0' ? '0' : value);
      }
    });
  });

  describe('sum', () => {
    it('is exact where floating point is not', () => {
      // 0.1 + 0.2 !== 0.3 in binary floating point. Here it must be exact, because this sum
      // decides whether a tracker-over-allocation warning fires on a boundary.
      expect(format(sum(['0.1', '0.2']))).toBe('0.3');
    });

    it('skips unparseable entries rather than throwing', () => {
      expect(format(sum(['1', 'nonsense', null, undefined, '2']))).toBe('3');
    });

    it('is zero for an empty list', () => {
      expect(sum([])).toBe(0n);
    });
  });

  describe('multiplyByInteger', () => {
    it('multiplies exactly', () => {
      expect(format(multiplyByInteger(parse('50') as bigint, 30))).toBe('1500');
    });

    it('truncates a fractional multiplier rather than producing a fractional day count', () => {
      expect(format(multiplyByInteger(parse('10') as bigint, 2.9))).toBe('20');
    });
  });

  describe('percentOf', () => {
    it('reports an exact percentage', () => {
      expect(percentOf(parse('250000') as bigint, parse('500000') as bigint)).toBe(50);
    });

    it('rounds half away from zero, so 99.6% is not reported as 99%', () => {
      expect(percentOf(parse('996') as bigint, parse('1000') as bigint)).toBe(100);
      expect(percentOf(parse('994') as bigint, parse('1000') as bigint)).toBe(99);
    });

    it('rounds a negative ratio away from zero too', () => {
      expect(percentOf(parse('-996') as bigint, parse('1000') as bigint)).toBe(-100);
    });

    it('returns null rather than dividing by zero', () => {
      expect(percentOf(parse('1') as bigint, 0n)).toBeNull();
    });
  });

  describe('daysBetween', () => {
    it('counts whole days, rounding up a partial one', () => {
      expect(daysBetween(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-08T00:00:00Z'))).toBe(
        7,
      );
      expect(daysBetween(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-08T06:00:00Z'))).toBe(
        8,
      );
    });

    it('never returns less than one, so a same-day campaign still multiplies by 1', () => {
      expect(daysBetween(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))).toBe(
        1,
      );
      expect(daysBetween(new Date('2026-09-08T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))).toBe(
        1,
      );
    });

    it('falls back to one day for an invalid date rather than producing NaN', () => {
      expect(daysBetween(new Date('nonsense'), new Date('2026-09-01T00:00:00Z'))).toBe(1);
    });
  });
});
