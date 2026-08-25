/**
 * T-015 — the `/me` contract, tested in the package that declares it.
 *
 * `back-end/test/me/bootstrap.contract.spec.ts` already parses a **real** payload through these
 * schemas, which is the assertion that catches drift between the two workspaces. This suite tests
 * the schemas themselves, for two reasons that suite cannot cover:
 *
 *  - the front end (T-020…T-024, T-046) will import these schemas and has no access to the back
 *    end's test suite. What `.strict()` rejects, and how the recursive nav item behaves, are facts
 *    a SPA developer needs to be able to read off a test here.
 *  - a schema that is *too permissive* silently stops being a contract. Every case below is a
 *    rejection: the schemas are only worth having if they say no to something.
 */
import {
  PORTAL_ROLES,
  bootstrapEnvelopeSchema,
  bootstrapNavItemSchema,
  bootstrapSchema,
  bootstrapWidgetSchema,
  meProfileSchema,
  updateMeSchema,
  BOOTSTRAP_CACHE_CONTROL,
} from './bootstrap.schema';

const user = {
  id: 12,
  displayName: 'A Maker',
  role: 'maker' as const,
  locale: 'en',
  timezone: 'Asia/Kolkata',
};
const scope = { countryId: 3, tenantId: 7, merchantId: null };
const bootstrap = {
  user,
  scope,
  nav: [{ key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] }],
  permissions: { campaign: ['view', 'create'] },
  widgets: [{ key: 'kpi_my_drafts', label: 'Drafts', config: { type: 'kpi' } }],
  messages: { NOT_FOUND: 'Not found.' },
};

describe('the six roles', () => {
  it('are exactly the roles 00-ARCHITECTURE.md §5 names', () => {
    expect([...PORTAL_ROLES]).toEqual([
      'super_admin',
      'country_admin',
      'tenant_admin',
      'maker',
      'checker',
      'merchant',
    ]);
  });

  it('reject an unknown role', () => {
    expect(
      bootstrapSchema.safeParse({ ...bootstrap, user: { ...user, role: 'root' } }).success,
    ).toBe(false);
  });
});

describe('bootstrapSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(bootstrapSchema.safeParse(bootstrap).success).toBe(true);
  });

  it('accepts the envelope form 03-API-CONTRACT.md §1 defines', () => {
    expect(bootstrapEnvelopeSchema.safeParse({ data: bootstrap }).success).toBe(true);
  });

  it('rejects an unknown top-level key — the TC-15 property', () => {
    expect(bootstrapSchema.safeParse({ ...bootstrap, session: {} }).success).toBe(false);
  });

  it('rejects an unknown key inside user, scope or a widget', () => {
    expect(
      bootstrapSchema.safeParse({ ...bootstrap, user: { ...user, passwordHash: 'x' } }).success,
    ).toBe(false);
    expect(
      bootstrapSchema.safeParse({ ...bootstrap, scope: { ...scope, adminUserId: 1 } }).success,
    ).toBe(false);
    expect(
      bootstrapWidgetSchema.safeParse({ ...bootstrap.widgets[0], sql: 'SELECT' }).success,
    ).toBe(false);
  });

  it('rejects a missing section rather than defaulting it', () => {
    for (const key of ['user', 'scope', 'nav', 'permissions', 'widgets', 'messages']) {
      const partial = { ...bootstrap } as Record<string, unknown>;
      delete partial[key];
      expect({ key, ok: bootstrapSchema.safeParse(partial).success }).toEqual({ key, ok: false });
    }
  });

  it('requires the three scope axes to be present, though each may be null', () => {
    expect(
      bootstrapSchema.safeParse({ ...bootstrap, scope: { countryId: null, tenantId: null } })
        .success,
    ).toBe(false);
    expect(
      bootstrapSchema.safeParse({
        ...bootstrap,
        scope: { countryId: null, tenantId: null, merchantId: null },
      }).success,
    ).toBe(true);
  });

  it('does not coerce — a stringified id is a contract violation, not a value to fix', () => {
    expect(bootstrapSchema.safeParse({ ...bootstrap, user: { ...user, id: '12' } }).success).toBe(
      false,
    );
  });

  it('requires a widget config to be an object, since the server normalises it to {}', () => {
    expect(bootstrapWidgetSchema.safeParse({ key: 'k', label: 'l', config: {} }).success).toBe(
      true,
    );
    expect(bootstrapWidgetSchema.safeParse({ key: 'k', label: 'l', config: null }).success).toBe(
      false,
    );
    expect(bootstrapWidgetSchema.safeParse({ key: 'k', label: 'l', config: 5 }).success).toBe(
      false,
    );
  });
});

describe('bootstrapNavItemSchema — the recursive one', () => {
  it('accepts an arbitrarily deep tree', () => {
    const leaf = { key: 'c', label: 'C', icon: null, path: '/c', children: [] };
    const mid = { key: 'b', label: 'B', icon: null, path: '/b', children: [leaf] };
    const root = { key: 'a', label: 'A', icon: 'home', path: '/a', children: [mid] };

    expect(bootstrapNavItemSchema.safeParse(root).success).toBe(true);
  });

  it('requires `children`, so a client never has to check for undefined', () => {
    expect(
      bootstrapNavItemSchema.safeParse({ key: 'a', label: 'A', icon: null, path: '/a' }).success,
    ).toBe(false);
  });

  it('rejects an unknown key at any depth', () => {
    const bad = {
      key: 'a',
      label: 'A',
      icon: null,
      path: '/a',
      children: [{ key: 'b', label: 'B', icon: null, path: '/b', children: [], secret: 'x' }],
    };

    expect(bootstrapNavItemSchema.safeParse(bad).success).toBe(false);
  });
});

describe('meProfileSchema', () => {
  const profile = {
    id: 12,
    email: 'maker@example.invalid',
    displayName: 'A Maker',
    role: 'maker' as const,
    scope,
    locale: 'en',
    timezone: null,
    status: 'active',
    mustChangePassword: false,
    lastLoginAt: null,
  };

  it('accepts a profile with a null timezone and a null lastLoginAt', () => {
    expect(meProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('rejects anything credential-bearing', () => {
    expect(meProfileSchema.safeParse({ ...profile, passwordHash: 'argon2id$…' }).success).toBe(
      false,
    );
    expect(meProfileSchema.safeParse({ ...profile, mfaSecretEnc: 'ciphertext' }).success).toBe(
      false,
    );
  });
});

describe('updateMeSchema — the escalation path', () => {
  it('accepts the three writable fields, individually and together', () => {
    expect(updateMeSchema.safeParse({}).success).toBe(true);
    expect(updateMeSchema.safeParse({ displayName: 'New' }).success).toBe(true);
    expect(
      updateMeSchema.safeParse({
        displayName: 'New',
        preferredLocale: 'en-GB',
        preferredTimezone: 'Europe/London',
      }).success,
    ).toBe(true);
  });

  it('rejects role, status and every scope field', () => {
    for (const field of ['role', 'status', 'tenantId', 'countryId', 'merchantId', 'id', 'email']) {
      expect({ field, ok: updateMeSchema.safeParse({ [field]: 'x' }).success }).toEqual({
        field,
        ok: false,
      });
    }
  });

  it('rejects an over-long name and a malformed locale', () => {
    expect(updateMeSchema.safeParse({ displayName: 'x'.repeat(101) }).success).toBe(false);
    expect(updateMeSchema.safeParse({ displayName: '' }).success).toBe(false);
    expect(updateMeSchema.safeParse({ preferredLocale: 'en_GB' }).success).toBe(false);
    expect(updateMeSchema.safeParse({ preferredLocale: 'en-GB-oed-x-toolong' }).success).toBe(
      false,
    );
  });
});

describe('BOOTSTRAP_CACHE_CONTROL', () => {
  it('is `private, no-cache` — never public, never a max-age', () => {
    expect(BOOTSTRAP_CACHE_CONTROL).toBe('private, no-cache');
  });
});
