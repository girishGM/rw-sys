/**
 * T-017 — `PolicySet`: the fail-closed ladder, the alias index, and row validation.
 *
 * This is the file where a mistake silently under-protects a column, so it is tested
 * exhaustively rather than representatively. TC-12 (*"field with no policy row in a `pii` table ⇒
 * treated as secret"*), TC-23 (blind index on a non-PII field rejected) and TC-24
 * (`ck_dpp_mask_strategy`'s application half) all live here.
 */
import { BLIND_INDEX_ALLOWED_CLASSIFICATIONS } from '@/common/crypto';
import {
  BLIND_INDEX_CLASSIFICATIONS,
  CLASSIFICATIONS,
  compareClassification,
  maxClassification,
  rankClassification,
  strictestLogTreatment,
  strictestUiVisibility,
} from '@/common/data-protection/data-protection.constants';
import {
  aliasesFor,
  DTO_KEY_PREFIX,
  ENGINE_DISABLED_POLICY,
  PolicySet,
  PolicyValidationError,
  splitPolicyKey,
  strictestOf,
  toCamelCase,
  toSnakeCase,
  validatePolicy,
  type ResolvedPolicy,
} from '@/common/data-protection/policy.service';
import { config, FIXTURE_POLICIES, policy, policySet } from './support/policies';

describe('the constants are the ones the migration and T-016 use', () => {
  it('BLIND_INDEX_CLASSIFICATIONS matches T-016 exactly', () => {
    // The zero-import leaf duplicates T-016's list so a migration can read it. Asserting equality
    // here is what stops the duplication drifting — see `data-protection.constants.ts`'s header.
    expect([...BLIND_INDEX_CLASSIFICATIONS]).toEqual([...BLIND_INDEX_ALLOWED_CLASSIFICATIONS]);
  });

  it('classifications are ordered by ascending sensitivity — the order is load-bearing', () => {
    expect([...CLASSIFICATIONS]).toEqual(['public', 'internal', 'confidential', 'pii', 'secret']);
    expect(compareClassification('secret', 'public')).toBeGreaterThan(0);
    expect(compareClassification('public', 'secret')).toBeLessThan(0);
    expect(compareClassification('pii', 'pii')).toBe(0);
  });

  it('ranks an unrecognised classification above secret, not below public', () => {
    expect(rankClassification('quantum')).toBeGreaterThan(rankClassification('secret'));
    expect(maxClassification('secret', 'public')).toBe('secret');
    expect(maxClassification('public', 'secret')).toBe('secret');
  });

  it('orders treatments by restrictiveness', () => {
    expect(strictestLogTreatment('plain', 'omit')).toBe('omit');
    expect(strictestLogTreatment('omit', 'mask')).toBe('omit');
    expect(strictestLogTreatment('mask', 'hash')).toBe('hash');
    expect(strictestUiVisibility('plain', 'never')).toBe('never');
    expect(strictestUiVisibility('masked', 'reveal_on_demand')).toBe('masked');
    expect(strictestUiVisibility('never', 'masked')).toBe('never');
  });
});

describe('policy-key handling', () => {
  it('splits on the LAST dot, so both key shapes work', () => {
    expect(splitPolicyKey('reward_portal.portal_users.email')).toEqual({
      container: 'reward_portal.portal_users',
      leaf: 'email',
    });
    expect(splitPolicyKey(`${DTO_KEY_PREFIX}CreateUserResponse.temporaryPassword`)).toEqual({
      container: 'dto.CreateUserResponse',
      leaf: 'temporaryPassword',
    });
  });

  it('indexes a snake_case column under both its forms, and a camelCase field under one', () => {
    expect(aliasesFor('reward_config.merchants.contact_email')).toEqual([
      'contact_email',
      'contactEmail',
    ]);
    expect(aliasesFor('dto.LoginRequest.password')).toEqual(['password']);
  });

  it('round-trips case conversion', () => {
    expect(toCamelCase('contact_email')).toBe('contactEmail');
    expect(toCamelCase('a_b_c')).toBe('aBC');
    expect(toSnakeCase('contactEmail')).toBe('contact_email');
    expect(toSnakeCase('email')).toBe('email');
  });
});

describe('validatePolicy', () => {
  const invalid = (over: Partial<Parameters<typeof policy>[0]> & { policyKey: string }) => () =>
    validatePolicy(policy(over));

  it('accepts a well-formed row', () => {
    expect(invalid({ policyKey: 'a.b.c' })).not.toThrow();
  });

  it('rejects an empty or wrongly-shaped key', () => {
    expect(invalid({ policyKey: '' })).toThrow(PolicyValidationError);
    expect(invalid({ policyKey: 'nodots' })).toThrow(PolicyValidationError);
    expect(invalid({ policyKey: 'trailing.' })).toThrow(PolicyValidationError);
    expect(invalid({ policyKey: '.leading' })).toThrow(PolicyValidationError);
    expect(() =>
      validatePolicy({ ...policy({ policyKey: 'a.b.c' }), policyKey: 3 as never }),
    ).toThrow(PolicyValidationError);
  });

  it('rejects an unknown classification', () => {
    expect(invalid({ policyKey: 'a.b.c', classification: 'quantum' as never })).toThrow(
      /unknown classification/,
    );
  });

  // TC-24 — the application half of ck_dpp_mask_strategy.
  it("rejects log_treatment='mask' with no strategy (TC-24)", () => {
    expect(invalid({ policyKey: 'a.b.c', logTreatment: 'mask' })).toThrow(/ck_dpp_mask_strategy/);
    expect(
      invalid({ policyKey: 'a.b.c', logTreatment: 'mask', maskStrategy: 'nope' as never }),
    ).toThrow(/ck_dpp_mask_strategy/);
    expect(
      invalid({ policyKey: 'a.b.c', logTreatment: 'mask', maskStrategy: 'email' }),
    ).not.toThrow();
  });

  it("rejects ui_visibility='reveal_on_demand' with no roles, including an empty array", () => {
    expect(invalid({ policyKey: 'a.b.c', uiVisibility: 'reveal_on_demand' })).toThrow(
      /reveal_roles/,
    );
    expect(
      invalid({ policyKey: 'a.b.c', uiVisibility: 'reveal_on_demand', revealRoles: [] }),
    ).toThrow(/reveal_roles/);
    expect(
      invalid({
        policyKey: 'a.b.c',
        uiVisibility: 'reveal_on_demand',
        revealRoles: ['super_admin'],
      }),
    ).not.toThrow();
  });

  // TC-23 — a blind index over low-cardinality data is broken by counting, not by cracking.
  it('rejects blind_index on a non-pii/secret classification (TC-23)', () => {
    for (const classification of ['public', 'internal', 'confidential'] as const) {
      expect(invalid({ policyKey: 'a.b.c', classification, blindIndex: true })).toThrow(
        /frequency analysis/,
      );
    }
    // The allowed two still need a registered normaliser, which is T-016's own fail-closed check;
    // the classification gate itself passes for both.
    for (const classification of ['pii', 'secret'] as const) {
      expect(invalid({ policyKey: 'a.b.c', classification, blindIndex: true })).not.toThrow(
        /frequency analysis/,
      );
    }
  });

  it('rejects blind_index on a dto_field — a request body is not indexed', () => {
    expect(
      invalid({
        policyKey: 'dto.X.y',
        scope: 'dto_field',
        classification: 'pii',
        blindIndex: true,
      }),
    ).toThrow(/only meaningful on a column policy|column policy/);
  });

  it('carries the offending key on the error, so the operator knows which row to fix', () => {
    try {
      validatePolicy(policy({ policyKey: 'a.b.c', logTreatment: 'mask' }));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as PolicyValidationError).policyKey).toBe('a.b.c');
      expect((error as PolicyValidationError).name).toBe('PolicyValidationError');
    }
  });
});

describe('PolicySet — exact rows', () => {
  const set = policySet(FIXTURE_POLICIES);

  it('resolves a column by its exact key', () => {
    const resolved = set.resolveColumn('reward_portal.portal_users', 'email');
    expect(resolved.source).toBe('row');
    expect(resolved.logTreatment).toBe('mask');
    expect(resolved.maskStrategy).toBe('email');
    expect(resolved.policyKey).toBe('reward_portal.portal_users.email');
  });

  it('resolves a DTO field by its exact key', () => {
    const resolved = set.resolveDtoField('LoginRequest', 'password');
    expect(resolved.source).toBe('row');
    expect(resolved.logTreatment).toBe('omit');
    expect(resolved.uiVisibility).toBe('never');
  });

  it('resolves by bare field name, in either case form', () => {
    expect(set.resolveFieldName('contact_email')?.maskStrategy).toBe('email');
    expect(set.resolveFieldName('contactEmail')?.maskStrategy).toBe('email');
  });

  it('returns null for a name it has never heard of', () => {
    expect(set.resolveFieldName('campaignName')).toBeNull();
  });

  it('exposes the raw row for the reveal endpoint', () => {
    expect(set.policyFor('reward_config.merchants.contact_email')?.revealRoles).toEqual([
      'super_admin',
      'tenant_admin',
    ]);
    expect(set.policyFor('nope.nope.nope')).toBeNull();
  });

  it('lists a table"s column policies and the protected tables, excluding DTO containers', () => {
    expect(set.columnPoliciesFor('reward_portal.portal_users').map((p) => p.policyKey)).toEqual([
      'reward_portal.portal_users.email',
      'reward_portal.portal_users.mfa_secret_enc',
    ]);
    expect(set.columnPoliciesFor('nothing.here')).toEqual([]);
    expect(set.protectedTables()).toEqual(
      expect.arrayContaining(['reward_portal.portal_users', 'reward_config.merchants']),
    );
    expect(set.protectedTables()).not.toContain('dto.LoginRequest');
  });

  it('counts enabled rows', () => {
    expect(set.size).toBe(FIXTURE_POLICIES.length);
  });
});

describe('PolicySet — the fail-closed ladder', () => {
  const set = policySet(FIXTURE_POLICIES);

  // TC-12. `portal_users` is classified `secret` because `mfa_secret_enc` is; an unlisted sibling
  // column therefore inherits the strict default instead of being logged in full.
  it('treats an unlisted column of a secret-classified table as secret (TC-12)', () => {
    const resolved = set.resolveColumn('reward_portal.portal_users', 'preferred_locale');
    expect(resolved.source).toBe('classification_default');
    expect(resolved.classification).toBe('secret');
    expect(resolved.logTreatment).toBe('omit');
    expect(resolved.uiVisibility).toBe('masked');
    expect(resolved.policyKey).toBeNull();
  });

  it('treats an unlisted column of a pii table as pii, using the configured defaults', () => {
    const resolved = set.resolveColumn('reward_config.merchants', 'legal_name');
    expect(resolved.classification).toBe('pii');
    expect(resolved.logTreatment).toBe('omit');
    expect(resolved.uiVisibility).toBe('masked');
  });

  it('honours a non-default logging.defaultTreatment', () => {
    const masking = policySet(
      FIXTURE_POLICIES,
      config({ logging: { defaultTreatment: 'mask' }, response: { defaultVisibility: 'never' } }),
    );
    const resolved = masking.resolveColumn('reward_config.merchants', 'legal_name');
    expect(resolved.logTreatment).toBe('mask');
    // A `mask` default must carry a strategy or it degrades to plain — the ck_dpp_mask_strategy
    // insight, applied to a derived treatment rather than to a row.
    expect(resolved.maskStrategy).toBe('full');
    expect(resolved.uiVisibility).toBe('never');
  });

  it('masks an unlisted column of a confidential table without omitting it', () => {
    const set2 = policySet([
      policy({ policyKey: 'x.y.a', classification: 'confidential', logTreatment: 'plain' }),
    ]);
    const resolved = set2.resolveColumn('x.y', 'b');
    expect(resolved.classification).toBe('confidential');
    expect(resolved.logTreatment).toBe('mask');
    expect(resolved.maskStrategy).toBe('full');
    expect(resolved.uiVisibility).toBe('masked');
  });

  it('leaves an unlisted column of a public or internal table plain', () => {
    const resolved = set.resolveColumn('reward_config.countries', 'name');
    expect(resolved.source).toBe('unclassified');
    expect(resolved.logTreatment).toBe('plain');
    expect(resolved.uiVisibility).toBe('plain');
  });

  it('leaves a column of a table nobody classified plain — otherwise every log line empties', () => {
    const resolved = set.resolveColumn('reward_config.trackers', 'name');
    expect(resolved.source).toBe('unclassified');
    expect(resolved.logTreatment).toBe('plain');
  });

  it('collapses the ladder when failClosed is off', () => {
    const open = policySet(FIXTURE_POLICIES, config({ failClosed: false }));
    const resolved = open.resolveColumn('reward_portal.portal_users', 'preferred_locale');
    expect(resolved.logTreatment).toBe('plain');
    expect(resolved.uiVisibility).toBe('plain');
    // An explicit row still wins — `failClosed` governs the *default*, not the declared rules.
    expect(open.resolveColumn('reward_portal.portal_users', 'email').logTreatment).toBe('mask');
  });

  it('reports a container classification, or null', () => {
    expect(set.classificationOf('reward_portal.portal_users')).toBe('secret');
    expect(set.classificationOf('reward_config.merchants')).toBe('pii');
    expect(set.classificationOf('reward_config.trackers')).toBeNull();
  });

  it('treats everything as plain when the engine is disabled', () => {
    const off = policySet(FIXTURE_POLICIES, config({ enabled: false }));
    expect(off.resolveColumn('reward_portal.portal_users', 'email')).toEqual(
      ENGINE_DISABLED_POLICY,
    );
    expect(off.resolveDtoField('LoginRequest', 'password')).toEqual(ENGINE_DISABLED_POLICY);
    expect(off.resolveFieldName('password')).toEqual(ENGINE_DISABLED_POLICY);
  });
});

describe('PolicySet — disabled rows', () => {
  const rows = [
    policy({
      policyKey: 'x.y.secret_col',
      classification: 'secret',
      logTreatment: 'omit',
      enabled: false,
    }),
    policy({ policyKey: 'x.y.other', classification: 'internal' }),
  ];
  const set = policySet(rows);

  it('does not resolve a disabled row', () => {
    expect(set.policyFor('x.y.secret_col')).toBeNull();
    expect(set.resolveFieldName('secret_col')).toBeNull();
    expect(set.size).toBe(1);
  });

  it('still counts its classification toward the container — disabling one row must not open the rest', () => {
    expect(set.classificationOf('x.y')).toBe('secret');
    expect(set.resolveColumn('x.y', 'unlisted').logTreatment).toBe('omit');
  });
});

describe('PolicySet — an ambiguous alias resolves to the strictest of the matches', () => {
  const set = policySet([
    policy({
      policyKey: 'a.b.token',
      classification: 'pii',
      logTreatment: 'mask',
      maskStrategy: 'email',
      uiVisibility: 'reveal_on_demand',
      revealRoles: ['super_admin', 'maker'],
    }),
    policy({
      policyKey: 'c.d.token',
      classification: 'secret',
      logTreatment: 'omit',
      uiVisibility: 'never',
      revealRoles: ['super_admin'],
    }),
  ]);

  it('takes the stricter treatment on every axis', () => {
    const resolved = set.resolveFieldName('token');
    expect(resolved?.logTreatment).toBe('omit');
    expect(resolved?.uiVisibility).toBe('never');
    expect(resolved?.classification).toBe('secret');
  });

  it('drops the policy key, because it is genuinely ambiguous', () => {
    expect(set.resolveFieldName('token')?.policyKey).toBeNull();
  });

  it('intersects reveal_roles — a role may unmask only if every match allows it', () => {
    const a: ResolvedPolicy = {
      policyKey: 'a.b.c',
      source: 'row',
      classification: 'pii',
      atRest: 'aes_256_gcm',
      blindIndex: true,
      inTransit: 'payload_encrypt',
      logTreatment: 'plain',
      maskStrategy: 'email',
      uiVisibility: 'reveal_on_demand',
      revealRoles: ['super_admin', 'maker'],
      keyPurpose: 'field',
    };
    const b: ResolvedPolicy = {
      ...a,
      policyKey: 'x.y.z',
      atRest: 'none',
      blindIndex: false,
      inTransit: 'tls_only',
      revealRoles: ['super_admin'],
      keyPurpose: 'transport',
    };
    const merged = strictestOf(a, b);
    expect(merged.revealRoles).toEqual(['super_admin']);
    // Disagreement on at_rest / key purpose is resolved to "no claim", never to one of them.
    expect(merged.atRest).toBe('none');
    expect(merged.blindIndex).toBe(false);
    expect(merged.keyPurpose).toBeNull();
    // …but payload encryption is the *stricter* transport, so disagreement escalates.
    expect(merged.inTransit).toBe('payload_encrypt');
  });

  it('keeps the key and the values when both sides are the same row', () => {
    const one: ResolvedPolicy = {
      policyKey: 'a.b.c',
      source: 'row',
      classification: 'pii',
      atRest: 'aes_256_gcm',
      blindIndex: true,
      inTransit: 'tls_only',
      logTreatment: 'mask',
      maskStrategy: 'email',
      uiVisibility: 'masked',
      revealRoles: [],
      keyPurpose: 'field',
    };
    const merged = strictestOf(one, one);
    expect(merged.policyKey).toBe('a.b.c');
    expect(merged.atRest).toBe('aes_256_gcm');
    expect(merged.blindIndex).toBe(true);
    expect(merged.maskStrategy).toBe('email');
    expect(merged.keyPurpose).toBe('field');
  });

  it('substitutes a full strategy when a merged mask treatment has none', () => {
    const base: ResolvedPolicy = {
      policyKey: 'a.b.c',
      source: 'row',
      classification: 'pii',
      atRest: 'none',
      blindIndex: false,
      inTransit: 'tls_only',
      logTreatment: 'mask',
      maskStrategy: null,
      uiVisibility: 'masked',
      revealRoles: [],
      keyPurpose: null,
    };
    expect(strictestOf(base, { ...base, policyKey: 'q.r.s' }).maskStrategy).toBe('full');
  });
});

describe('PolicySet — construction failures', () => {
  it('refuses the whole configuration when any row is invalid', () => {
    expect(() =>
      policySet([
        policy({ policyKey: 'a.b.c' }),
        policy({ policyKey: 'd.e.f', logTreatment: 'mask' }),
      ]),
    ).toThrow(PolicyValidationError);
  });

  it('refuses duplicate keys — uq_dpp_key should make it impossible, so it is a real bug', () => {
    expect(() =>
      policySet([policy({ policyKey: 'a.b.c' }), policy({ policyKey: 'a.b.c' })]),
    ).toThrow(/Duplicate policy key/);
  });

  it('builds an empty set without complaint', () => {
    const empty = new PolicySet([], config());
    expect(empty.size).toBe(0);
    expect(empty.resolveFieldName('anything')).toBeNull();
    expect(empty.resolveColumn('a.b', 'c').logTreatment).toBe('plain');
    expect(empty.protectedTables()).toEqual([]);
  });
});
