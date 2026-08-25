/**
 * T-040 — `csv.util.ts`. TC-19 is the one implementation note 6 calls out as "the one most often
 * missed" — a leading `=`, `+`, `-` or `@` must never reach the file unescaped.
 */
import { neutraliseFormulaInjection, toCsvHeader, toCsvLine } from '@/modules/audit/csv.util';

describe('TC-19 — CSV injection neutralisation', () => {
  it.each(['=cmd|/c calc', '+1+1', '-1+1', '@SUM(A1:A2)', '=HYPERLINK("https://evil","click")'])(
    'prefixes %j with a leading apostrophe',
    (dangerous) => {
      expect(neutraliseFormulaInjection(dangerous)).toBe(`'${dangerous}`);
    },
  );

  it('leaves an ordinary cell untouched', () => {
    expect(neutraliseFormulaInjection('campaign_submitted')).toBe('campaign_submitted');
  });

  it('leaves an empty cell untouched', () => {
    expect(neutraliseFormulaInjection('')).toBe('');
  });

  it('neutralises a dangerous cell inside a full CSV line, still quoted correctly', () => {
    const line = toCsvLine(['1', '=HYPERLINK("https://evil","click")', 'ok']);
    expect(line).toContain('"\'=HYPERLINK(""https://evil"",""click"")"');
  });
});

describe('quoting', () => {
  it('quotes a cell containing a comma', () => {
    expect(toCsvLine(['a,b'])).toBe('"a,b"\r\n');
  });

  it('quotes a cell containing a double quote, doubling it', () => {
    expect(toCsvLine(['say "hi"'])).toBe('"say ""hi"""\r\n');
  });

  it('quotes a cell containing a newline', () => {
    expect(toCsvLine(['line1\nline2'])).toBe('"line1\nline2"\r\n');
  });

  it('does not quote an ordinary cell', () => {
    expect(toCsvLine(['ordinary', 42, true, false, null])).toBe('ordinary,42,true,false,\r\n');
  });
});

describe('toCsvHeader', () => {
  it('renders the column list as one CSV line', () => {
    expect(toCsvHeader(['id', 'action'])).toBe('id,action\r\n');
  });
});
