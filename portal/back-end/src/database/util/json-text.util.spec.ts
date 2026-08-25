import { parseJsonColumn, stringifyJsonColumn } from './json-text.util';

describe('parseJsonColumn / stringifyJsonColumn (T-003 TC-8, TC-9)', () => {
  it('parses well-formed JSON', () => {
    expect(parseJsonColumn('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJsonColumn('["view","create"]', [])).toEqual(['view', 'create']);
  });

  it('tolerates malformed JSON by returning the fallback, never throwing (TC-8)', () => {
    expect(() => parseJsonColumn('{not valid json', {})).not.toThrow();
    expect(parseJsonColumn('{not valid json', { fallback: true })).toEqual({ fallback: true });
  });

  it('returns the fallback for null, undefined and empty string', () => {
    expect(parseJsonColumn(null, { fallback: true })).toEqual({ fallback: true });
    expect(parseJsonColumn(undefined, { fallback: true })).toEqual({ fallback: true });
    expect(parseJsonColumn('', { fallback: true })).toEqual({ fallback: true });
  });

  it('returns [] fallback for an actions-shaped column (TC-9)', () => {
    expect(parseJsonColumn<string[]>('not json', [])).toEqual([]);
    expect(parseJsonColumn<string[]>('["view","create","update"]', [])).toEqual([
      'view',
      'create',
      'update',
    ]);
  });

  it('passes an already-parsed value through unchanged (defensive, non-string input)', () => {
    expect(parseJsonColumn({ already: 'parsed' }, {})).toEqual({ already: 'parsed' });
  });

  it('round-trips through stringifyJsonColumn', () => {
    const value = { a: 1, b: ['x', 'y'] };
    expect(parseJsonColumn(stringifyJsonColumn(value), {})).toEqual(value);
  });

  it('stringifyJsonColumn maps null/undefined to SQL NULL, not the strings "null"/"undefined"', () => {
    expect(stringifyJsonColumn(null)).toBeNull();
    expect(stringifyJsonColumn(undefined)).toBeNull();
  });
});
