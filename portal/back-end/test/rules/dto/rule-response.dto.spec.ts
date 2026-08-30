/**
 * T-114 — `withParameterFieldRoles`, the pure DTO-shaping function `rules.service.ts` calls on
 * every read path that returns `rule_master.parameters`. Unit-tested directly (rather than only
 * indirectly through `RulesService`'s own tests) so every branch — a non-array `fields`, a
 * malformed field entry, a field with no `key` — has a dedicated case, not just the "well-formed
 * rule row" shape `rules.service.spec.ts` exercises.
 */
import { withParameterFieldRoles } from '@/modules/rules/dto/rule-response.dto';

describe('withParameterFieldRoles', () => {
  it('marks a field whose key is in resolverInputFieldKeys as resolver_input', () => {
    const result = withParameterFieldRoles(
      { fields: [{ key: 'targetComponentCode', label: 'Sibling', type: 'string' }] },
      new Set(['targetComponentCode']),
    );
    expect(result).toEqual({
      fields: [
        { key: 'targetComponentCode', label: 'Sibling', type: 'string', role: 'resolver_input' },
      ],
    });
  });

  it('marks every other field as compare_value', () => {
    const result = withParameterFieldRoles(
      { fields: [{ key: 'value', label: 'Value', type: 'string' }] },
      new Set(['targetComponentCode']),
    );
    expect(result).toEqual({
      fields: [{ key: 'value', label: 'Value', type: 'string', role: 'compare_value' }],
    });
  });

  it('marks every field compare_value when resolverInputFieldKeys is empty (T-114 TC-4)', () => {
    const result = withParameterFieldRoles(
      { fields: [{ key: 'value', label: 'Value', type: 'string' }] },
      new Set(),
    );
    expect(result).toEqual({
      fields: [{ key: 'value', label: 'Value', type: 'string', role: 'compare_value' }],
    });
  });

  it('handles a mix of resolver_input and compare_value fields in one call', () => {
    const result = withParameterFieldRoles(
      {
        fields: [
          { key: 'targetComponentCode', label: 'Sibling' },
          { key: 'value', label: 'Value' },
        ],
      },
      new Set(['targetComponentCode']),
    );
    expect(result).toEqual({
      fields: [
        { key: 'targetComponentCode', label: 'Sibling', role: 'resolver_input' },
        { key: 'value', label: 'Value', role: 'compare_value' },
      ],
    });
  });

  it('never mutates its input', () => {
    const input = { fields: [{ key: 'value', label: 'Value' }] };
    const inputCopy = JSON.parse(JSON.stringify(input)) as unknown;
    withParameterFieldRoles(input, new Set(['value']));
    expect(input).toEqual(inputCopy);
  });

  it('returns a bare {} (no fields key) unchanged — tolerant of legacy/malformed content', () => {
    const result = withParameterFieldRoles({}, new Set(['value']));
    expect(result).toEqual({});
  });

  it('returns parameters unchanged when fields is not an array', () => {
    const result = withParameterFieldRoles({ fields: 'not-an-array' }, new Set(['value']));
    expect(result).toEqual({ fields: 'not-an-array' });
  });

  it('leaves a malformed (non-object) field entry untouched rather than guessing at a role', () => {
    const result = withParameterFieldRoles({ fields: ['not-an-object', null] }, new Set());
    expect(result).toEqual({ fields: ['not-an-object', null] });
  });

  it('leaves a field entry with no key untouched', () => {
    const result = withParameterFieldRoles({ fields: [{ label: 'No key here' }] }, new Set());
    expect(result).toEqual({ fields: [{ label: 'No key here' }] });
  });
});
