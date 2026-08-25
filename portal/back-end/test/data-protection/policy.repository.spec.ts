/**
 * T-017 — `PolicyRepository`, and the `jsonb → string[]` coercion that decides who may unmask.
 *
 * `toRoleArray` gets its own block because it is the one place a *malformed* value could produce
 * a partially-usable answer. A `reveal_roles` of `["super_admin", 2]` must mean "nobody", not
 * "the first one" — the fail-closed reading — and that is a decision a coercion helper makes
 * silently unless somebody asserts it.
 */
import {
  PolicyRepository,
  toPolicy,
  toRoleArray,
} from '@/common/data-protection/policy.repository';

const ROW = {
  policy_key: 'reward_config.merchants.contact_email',
  scope: 'column',
  classification: 'pii',
  at_rest: 'none',
  blind_index: false,
  in_transit: 'tls_only',
  log_treatment: 'mask',
  mask_strategy: 'email',
  ui_visibility: 'reveal_on_demand',
  reveal_roles: ['super_admin'],
  key_purpose: null,
  enabled: true,
  note: 'a note',
};

describe('toPolicy', () => {
  it('maps every column to its application name', () => {
    expect(toPolicy(ROW)).toEqual({
      policyKey: 'reward_config.merchants.contact_email',
      scope: 'column',
      classification: 'pii',
      atRest: 'none',
      blindIndex: false,
      inTransit: 'tls_only',
      logTreatment: 'mask',
      maskStrategy: 'email',
      uiVisibility: 'reveal_on_demand',
      revealRoles: ['super_admin'],
      keyPurpose: null,
      enabled: true,
      note: 'a note',
    });
  });
});

describe('toRoleArray', () => {
  it('passes a parsed array through', () => {
    expect(toRoleArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(toRoleArray([])).toEqual([]);
  });

  it('parses the string form, for a driver with no jsonb type parser', () => {
    expect(toRoleArray('["super_admin"]')).toEqual(['super_admin']);
  });

  it('is null for null and undefined', () => {
    expect(toRoleArray(null)).toBeNull();
    expect(toRoleArray(undefined)).toBeNull();
  });

  it('is null — not a partial array — for anything malformed', () => {
    for (const value of ['not json', '{"a":1}', 42, { a: 1 }, ['ok', 2], [null]]) {
      expect(toRoleArray(value)).toBeNull();
    }
  });

  it('freezes its result, so a consumer cannot widen the allow-list in place', () => {
    const roles = toRoleArray(['super_admin']) as string[];
    expect(() => roles.push('merchant')).toThrow();
  });
});

describe('findAllPolicies', () => {
  it('reads every row, enabled or not, ordered by key', async () => {
    const queries: { sql: string; options: unknown }[] = [];
    const sequelize = {
      query: (sql: string, options: unknown) => {
        queries.push({ sql, options });
        return Promise.resolve([ROW, { ...ROW, policy_key: 'a.b.c', enabled: false }]);
      },
    };

    const rows = await new PolicyRepository(sequelize as never).findAllPolicies();

    expect(rows).toHaveLength(2);
    expect(rows[1].enabled).toBe(false);
    expect(queries[0].sql).toContain('reward_portal.data_protection_policies');
    expect(queries[0].sql).toContain('ORDER BY policy_key');
    // No WHERE enabled: `PolicySet` needs the disabled rows to compute a container's
    // classification, so filtering here would quietly open up every unlisted sibling column.
    expect(queries[0].sql).not.toContain('WHERE');
  });
});
