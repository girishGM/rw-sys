/**
 * T-018 — mode resolution and the client advertisement (TC-6, TC-7, TC-8, TC-9, TC-10).
 *
 * The precedence order is the interesting part, and one ordering here is a security decision:
 * **the always-cleartext list beats a route override.** T017_002 seeds
 * `dto.LoginRequest.password` as `in_transit = 'payload_encrypt'`, so a config that also declared
 * an override on `POST /auth/login` would otherwise have this service asking for the login body
 * to be encrypted with a key that, by definition, does not exist yet.
 */
import {
  DEFAULT_DATA_PROTECTION_CONFIG,
  normaliseRouteOverrideKey,
  type DataProtectionConfig,
  type TransportMode,
} from '@/common/data-protection/data-protection.config';
import type { PolicyCacheService } from '@/common/data-protection/policy-cache.service';
import {
  PolicySet,
  type DataProtectionPolicy,
  type ResolvedPolicy,
} from '@/common/data-protection/policy.service';
import { TransportPolicyService } from '@/common/transport-crypto/transport-policy.service';

function config(
  mode: TransportMode,
  routeOverrides: Record<string, TransportMode> = {},
): DataProtectionConfig {
  return {
    ...DEFAULT_DATA_PROTECTION_CONFIG,
    transport: { mode, routeOverrides },
  };
}

/** A minimal `PolicyCacheService` double — only the three members this service touches. */
function policies(options: {
  payloadEncrypt?: readonly string[];
  loaded?: boolean;
  fieldNames?: readonly string[];
}): PolicyCacheService {
  const flagged = new Set(options.payloadEncrypt ?? []);
  return {
    resolveFieldNameSafe: (name: string): ResolvedPolicy | null =>
      flagged.has(name)
        ? ({ inTransit: 'payload_encrypt' } as ResolvedPolicy)
        : ({ inTransit: 'tls_only' } as ResolvedPolicy),
    get isLoaded(): boolean {
      return options.loaded ?? true;
    },
    current: () => ({ payloadEncryptFieldNames: () => options.fieldNames ?? [] }),
  } as unknown as PolicyCacheService;
}

describe('modeFor', () => {
  it('falls back to the global mode', () => {
    const service = new TransportPolicyService(config('fields'), policies({}));
    expect(service.modeFor('POST', '/api/v1/campaigns')).toBe('fields');
  });

  it('TC-8 — a route override wins over the global mode', () => {
    const service = new TransportPolicyService(
      config('fields', { 'POST /users': 'full' }),
      policies({}),
    );
    expect(service.modeFor('POST', '/api/v1/users')).toBe('full');
    expect(service.modeFor('POST', '/api/v1/campaigns')).toBe('fields');
  });

  it('normalises the incoming method and path before looking an override up', () => {
    // The division of labour: `parseDataProtectionConfig` (T-017) normalises the *stored* keys as
    // it loads them — §5's own example writes `"GET  /health"` with two spaces — and this service
    // normalises the *incoming* request the same way, through the same exported function. Both
    // halves are needed; either alone silently misses.
    expect(normaliseRouteOverrideKey('post   /Users')).toBe('POST /users');

    const service = new TransportPolicyService(
      config('off', { [normaliseRouteOverrideKey('post   /Users')]: 'full' }),
      policies({}),
    );
    expect(service.modeFor('post', '/api/v1/USERS/')).toBe('full');
  });

  it('an override applies to one method only', () => {
    const service = new TransportPolicyService(
      config('fields', { 'POST /users': 'full' }),
      policies({}),
    );
    expect(service.modeFor('GET', '/api/v1/users')).toBe('fields');
  });

  it('TC-7 — `off` disables everything', () => {
    const service = new TransportPolicyService(config('off'), policies({}));
    expect(service.modeFor('POST', '/api/v1/campaigns')).toBe('off');
  });

  it.each([
    ['/api/v1/auth/login', 'POST'],
    ['/api/v1/auth/refresh', 'POST'],
    ['/api/v1/auth/forgot-password', 'POST'],
    ['/api/v1/auth/reset-password', 'POST'],
    ['/api/v1/health', 'GET'],
  ])('TC-9/TC-10 — %s is always cleartext even in `full` mode', (path, method) => {
    const service = new TransportPolicyService(config('full'), policies({}));
    expect(service.modeFor(method, path)).toBe('off');
  });

  it('a route override cannot switch encryption on for /auth/login', () => {
    const service = new TransportPolicyService(
      config('full', { 'POST /auth/login': 'full' }),
      policies({}),
    );
    expect(service.modeFor('POST', '/api/v1/auth/login')).toBe('off');
  });
});

describe('isPayloadEncryptField', () => {
  it('follows the policy table', () => {
    const service = new TransportPolicyService(
      config('fields'),
      policies({ payloadEncrypt: ['newPassword'] }),
    );
    expect(service.isPayloadEncryptField('newPassword')).toBe(true);
    expect(service.isPayloadEncryptField('campaignCode')).toBe(false);
  });

  it('is false when the cache answers with nothing at all', () => {
    const service = new TransportPolicyService(config('fields'), {
      resolveFieldNameSafe: () => null,
    } as unknown as PolicyCacheService);
    expect(service.isPayloadEncryptField('anything')).toBe(false);
  });
});

describe('PolicySet.payloadEncryptFieldNames (the accessor T-018 added to T-017)', () => {
  /** A minimal, valid policy row. */
  function row(policyKey: string, inTransit: 'tls_only' | 'payload_encrypt'): DataProtectionPolicy {
    return {
      policyKey,
      scope: policyKey.startsWith('dto.') ? 'dto_field' : 'column',
      classification: 'pii',
      atRest: 'none',
      blindIndex: false,
      inTransit,
      logTreatment: 'omit',
      maskStrategy: null,
      uiVisibility: 'masked',
      revealRoles: null,
      keyPurpose: null,
      enabled: true,
      note: null,
    };
  }

  it('lists only the flagged fields, sorted, in both snake_case and camelCase', () => {
    const set = new PolicySet(
      [
        row('dto.ChangePasswordRequest.newPassword', 'payload_encrypt'),
        row('dto.CreateUserResponse.temporaryPassword', 'payload_encrypt'),
        row('reward_portal.merchants.contact_email', 'payload_encrypt'),
        row('dto.CampaignResponse.campaignCode', 'tls_only'),
      ],
      DEFAULT_DATA_PROTECTION_CONFIG,
    );

    // A column policy governs both spellings — `contact_email` in the database, `contactEmail`
    // in the DTO — so the client is told about both.
    expect(set.payloadEncryptFieldNames()).toEqual([
      'contactEmail',
      'contact_email',
      'newPassword',
      'temporaryPassword',
    ]);
  });

  it('is empty when nothing is flagged', () => {
    const set = new PolicySet([row('dto.X.y', 'tls_only')], DEFAULT_DATA_PROTECTION_CONFIG);
    expect(set.payloadEncryptFieldNames()).toEqual([]);
  });

  it('excludes disabled rows, because a disabled policy governs nothing', () => {
    const set = new PolicySet(
      [{ ...row('dto.X.secretValue', 'payload_encrypt'), enabled: false }],
      DEFAULT_DATA_PROTECTION_CONFIG,
    );
    expect(set.payloadEncryptFieldNames()).toEqual([]);
  });
});

describe('advertisement', () => {
  it('carries the mode, the overrides and the flagged field names — and nothing else', () => {
    const service = new TransportPolicyService(
      config('fields', { 'POST /users': 'full' }),
      policies({ fieldNames: ['currentPassword', 'newPassword'] }),
    );

    const advertised = service.advertisement();

    expect(advertised).toEqual({
      mode: 'fields',
      routeOverrides: { 'POST /users': 'full' },
      fields: ['currentPassword', 'newPassword'],
    });
    // Field *names* only — never a value, never key material (R4).
    expect(JSON.stringify(advertised)).not.toMatch(/v1\.|BEGIN |[A-Za-z0-9+/]{40,}/);
  });

  it('advertises no fields when the policy cache is unloaded', () => {
    const service = new TransportPolicyService(
      config('fields'),
      policies({ loaded: false, fieldNames: ['newPassword'] }),
    );
    expect(service.advertisement().fields).toEqual([]);
  });

  it('is JSON-serialisable into a single header line', () => {
    const service = new TransportPolicyService(
      config('full', { 'POST /users': 'full' }),
      policies({ fieldNames: ['newPassword'] }),
    );
    const header = JSON.stringify(service.advertisement());
    expect(header).not.toMatch(/[\r\n]/);
    expect(JSON.parse(header)).toEqual(service.advertisement());
  });
});
