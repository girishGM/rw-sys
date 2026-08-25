/**
 * T-017 — enforcement point ④. TC-13, TC-14, TC-19 and TC-21.
 *
 * The assertion this file exists for is TC-14: **a role listed in `reveal_roles` still sees the
 * masked value in a list.** Getting that backwards would make the audit trail in §8 record
 * nothing, because a support agent could harvest 400 addresses with one list call.
 */
import { Reflector } from '@nestjs/core';
import { Logger, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import {
  attachRevealable,
  maskDeep,
  maskEverything,
  MAX_RESPONSE_DEPTH,
  NO_RESPONSE_MASKING_KEY,
  NoResponseMasking,
  REVEALABLE_FIELDS_KEY,
  ResponseMaskingInterceptor,
} from '@/common/data-protection/response-masking.interceptor';
import { PolicyCacheService } from '@/common/data-protection/policy-cache.service';
import { MASK_CHAR } from '@/common/data-protection/data-protection.constants';
import { maskFull } from '@/common/data-protection/mask.strategies';
import type { PolicyStore } from '@/common/data-protection/policy.repository';
import type { DataProtectionPolicy } from '@/common/data-protection/policy.service';
import { config, FIXTURE_POLICIES } from './support/policies';

const MASKED_EMAIL = `j${MASK_CHAR.repeat(4)}@example.com`;

class Store implements PolicyStore {
  constructor(private readonly rows: readonly DataProtectionPolicy[] = FIXTURE_POLICIES) {}
  findAllPolicies(): Promise<DataProtectionPolicy[]> {
    return Promise.resolve([...this.rows]);
  }
}

async function loadedCache(): Promise<PolicyCacheService> {
  const cache = new PolicyCacheService(new Store(), config());
  await cache.onModuleInit();
  return cache;
}

/** A cache that has never loaded — every lookup fails closed. */
function brokenCache(): PolicyCacheService {
  return new PolicyCacheService(
    { findAllPolicies: () => Promise.reject(new Error('down')) },
    config(),
  );
}

function contextFor(role: string | null, handlerMetadata = false): ExecutionContext {
  const handler = (): void => undefined;
  if (handlerMetadata) NoResponseMasking()(handler as never, 'x' as never, {} as never);
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => (role === null ? {} : { authUser: { role } }),
    }),
  } as unknown as ExecutionContext;
}

const nextWith = (body: unknown): CallHandler => ({ handle: () => of(body) });

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('ui_visibility', () => {
  let interceptor: ResponseMaskingInterceptor;
  beforeEach(async () => {
    interceptor = new ResponseMaskingInterceptor(await loadedCache(), new Reflector());
  });

  // TC-13 — merchants.contact_email is reveal_on_demand, so a list masks it.
  it('masks a reveal_on_demand field for a tenant_admin (TC-13)', () => {
    const out = interceptor.maskBody(
      { data: [{ id: 1, contactEmail: 'john@example.com' }] },
      'tenant_admin',
    ) as { data: { contactEmail: string }[] };
    expect(out.data[0].contactEmail).toBe(MASKED_EMAIL);
  });

  // TC-14 — the same field, for a role that IS in reveal_roles. Still masked.
  it('still masks for a role listed in reveal_roles (TC-14)', () => {
    for (const role of ['super_admin', 'tenant_admin']) {
      const out = interceptor.maskBody({ data: { contactEmail: 'john@example.com' } }, role) as {
        data: { contactEmail: string };
      };
      expect(out.data.contactEmail).toBe(MASKED_EMAIL);
    }
  });

  it('advertises the field as revealable to a listed role, and not to anyone else', () => {
    const allowed = interceptor.maskBody(
      { data: { contactEmail: 'john@example.com' } },
      'super_admin',
    ) as Record<string, unknown>;
    expect(allowed[REVEALABLE_FIELDS_KEY]).toEqual(['reward_config.merchants.contact_email']);

    for (const role of ['maker', 'merchant', null]) {
      const denied = interceptor.maskBody(
        { data: { contactEmail: 'john@example.com' } },
        role,
      ) as Record<string, unknown>;
      expect(denied[REVEALABLE_FIELDS_KEY]).toBeUndefined();
    }
  });

  // TC-19 — `never` removes the key entirely; a masked value would confirm it exists.
  it('omits a ui_visibility=never field from the response entirely (TC-19)', () => {
    const out = interceptor.maskBody(
      { data: { id: 1, mfaSecretEnc: 'v1.x', password: 'p' } },
      'super_admin',
    ) as { data: Record<string, unknown> };
    expect(out.data).toEqual({ id: 1 });
    expect('mfaSecretEnc' in out.data).toBe(false);
    expect('password' in out.data).toBe(false);
  });

  it('passes a plain field through in full', () => {
    const out = interceptor.maskBody({ data: { email: 'john@example.com' } }, 'maker') as {
      data: { email: string };
    };
    expect(out.data.email).toBe('john@example.com');
  });

  it('leaves a field with no policy alone', () => {
    const out = interceptor.maskBody({ data: { campaignName: 'Launch' } }, 'maker') as {
      data: { campaignName: string };
    };
    expect(out.data.campaignName).toBe('Launch');
  });

  it('masks a masked field with full when its policy names no strategy', async () => {
    const cache = new PolicyCacheService(
      new Store([
        {
          policyKey: 'a.b.thing',
          scope: 'column',
          classification: 'confidential',
          atRest: 'none',
          blindIndex: false,
          inTransit: 'tls_only',
          logTreatment: 'plain',
          maskStrategy: null,
          uiVisibility: 'masked',
          revealRoles: null,
          keyPurpose: null,
          enabled: true,
          note: null,
        },
      ]),
      config(),
    );
    await cache.onModuleInit();
    const out = new ResponseMaskingInterceptor(cache, new Reflector()).maskBody(
      { thing: 'visible' },
      'super_admin',
    ) as Record<string, unknown>;
    expect(out.thing).toBe(maskFull());
  });
});

describe('walking the body', () => {
  let interceptor: ResponseMaskingInterceptor;
  beforeEach(async () => {
    interceptor = new ResponseMaskingInterceptor(await loadedCache(), new Reflector());
  });

  it('handles null, undefined, primitives, Dates and Buffers', () => {
    const date = new Date('2026-08-18T00:00:00.000Z');
    const buffer = Buffer.from('x');
    expect(interceptor.maskBody(null, 'maker')).toBeNull();
    expect(interceptor.maskBody(undefined, 'maker')).toBeUndefined();
    expect(interceptor.maskBody(7, 'maker')).toBe(7);
    const out = interceptor.maskBody({ date, buffer }, 'maker') as Record<string, unknown>;
    expect(out.date).toBe(date);
    expect(out.buffer).toBe(buffer);
  });

  it('drops a cycle rather than hanging the serialiser', () => {
    const body: Record<string, unknown> = { a: 1 };
    body.self = body;
    expect(interceptor.maskBody(body, 'maker')).toEqual({ a: 1, self: undefined });
  });

  it('bounds depth', () => {
    let deep: Record<string, unknown> = { contactEmail: 'john@example.com' };
    for (let i = 0; i <= MAX_RESPONSE_DEPTH + 2; i += 1) deep = { next: deep };
    expect(() => interceptor.maskBody(deep, 'maker')).not.toThrow();
  });

  it('renders a repeated sibling twice', () => {
    const shared = { campaignName: 'Launch' };
    expect(interceptor.maskBody({ a: shared, b: shared }, 'maker')).toEqual({
      a: { campaignName: 'Launch' },
      b: { campaignName: 'Launch' },
    });
  });

  it('applies the classification ladder inside a model instance', () => {
    class FakeUser {
      static getTableName(): { tableName: string; schema: string } {
        return { tableName: 'portal_users', schema: 'reward_portal' };
      }
      getDataValue(): unknown {
        return undefined;
      }
      email = 'john@example.com';
      preferredLocale = 'en';
    }
    const out = interceptor.maskBody({ data: new FakeUser() }, 'super_admin') as {
      data: Record<string, unknown>;
    };
    // `email` has a `plain` row; `preferred_locale` has none and the table is `secret`.
    expect(out.data.email).toBe('john@example.com');
    expect(out.data.preferredLocale).toBe(maskFull());
  });
});

describe('the interceptor itself', () => {
  it('masks a real handler result', async () => {
    const interceptor = new ResponseMaskingInterceptor(await loadedCache(), new Reflector());
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor('tenant_admin'),
        nextWith({ data: { contactEmail: 'john@example.com' } }),
      ),
    );
    expect((result as { data: { contactEmail: string } }).data.contactEmail).toBe(MASKED_EMAIL);
  });

  it('skips a route marked @NoResponseMasking — the reveal endpoint', async () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const interceptor = new ResponseMaskingInterceptor(await loadedCache(), reflector);
    const body = { data: { contactEmail: 'john@example.com' } };
    expect(await lastValueFrom(interceptor.intercept(contextFor('maker'), nextWith(body)))).toBe(
      body,
    );
  });

  it('reads the role from the verified request, never from the payload (R3)', async () => {
    const interceptor = new ResponseMaskingInterceptor(await loadedCache(), new Reflector());
    // A body claiming super_admin changes nothing: the role comes from `request.authUser`.
    const result = (await lastValueFrom(
      interceptor.intercept(
        contextFor(null),
        nextWith({ role: 'super_admin', data: { contactEmail: 'john@example.com' } }),
      ),
    )) as { data: { contactEmail: string } } & Record<string, unknown>;
    expect(result.data.contactEmail).toBe(MASKED_EMAIL);
    expect(result[REVEALABLE_FIELDS_KEY]).toBeUndefined();
  });

  it('declares its metadata key', () => {
    expect(NO_RESPONSE_MASKING_KEY).toBe('dp:noResponseMasking');
  });
});

// TC-21 — the interceptor must not fail the request, and must not send the body unmasked.
describe('fail-closed (TC-21)', () => {
  it('masks every string when the policy cache cannot answer', async () => {
    const interceptor = new ResponseMaskingInterceptor(brokenCache(), new Reflector());
    const out = interceptor.maskBody(
      { data: { campaignName: 'Launch', contactEmail: 'john@example.com', id: 7, ok: true } },
      'super_admin',
    ) as { data: Record<string, unknown> };
    expect(out.data.campaignName).toBe(maskFull());
    expect(out.data.contactEmail).toBe(maskFull());
    // Structure, ids and flags survive: the client must still render a page it can report.
    expect(out.data.id).toBe(7);
    expect(out.data.ok).toBe(true);
  });

  it('does not fail the request', async () => {
    const interceptor = new ResponseMaskingInterceptor(brokenCache(), new Reflector());
    await expect(
      lastValueFrom(interceptor.intercept(contextFor('maker'), nextWith({ a: 'b' }))),
    ).resolves.toBeDefined();
  });

  it('falls back to a fully-masked body when the walk itself throws', async () => {
    const interceptor = new ResponseMaskingInterceptor(await loadedCache(), new Reflector());
    const hostile = {
      get boom(): string {
        throw new Error('nope');
      },
    };
    const out = interceptor.maskBody({ data: { name: 'x', hostile } }, 'maker') as {
      data: { name: string };
    };
    expect(out.data.name).toBe(maskFull());
  });
});

describe('maskDeep', () => {
  it('masks every scalar leaf of a structure instead of collapsing it', () => {
    // Numbers included: a credential inside a masked blob is no less a credential for being
    // numeric. The gentler, ids-preserving rendering is `maskEverything`, used only fail-closed.
    expect(maskDeep({ a: 'x', b: [{ c: 'y' }], n: 1 }, 'full', 0)).toEqual({
      a: maskFull(),
      b: [{ c: maskFull() }],
      n: maskFull(),
    });
  });

  it('passes null and undefined through, keeps Dates and Buffers, and bounds depth', () => {
    const date = new Date();
    const buffer = Buffer.from('x');
    expect(maskDeep(null, 'full', 0)).toBeNull();
    expect(maskDeep(undefined, 'full', 0)).toBeUndefined();
    expect(maskDeep({ date, buffer }, 'full', 0)).toEqual({ date, buffer: maskFull() });
    expect(maskDeep({ a: 1 }, 'full', MAX_RESPONSE_DEPTH + 1)).toBeUndefined();
  });

  it('survives a throwing getter', () => {
    expect(
      maskDeep(
        {
          get boom(): string {
            throw new Error('nope');
          },
        },
        'full',
        0,
      ),
    ).toEqual({ boom: maskFull() });
  });
});

describe('maskEverything', () => {
  it('keeps structure, ids and flags while masking every string', () => {
    expect(maskEverything({ id: 7, ok: true, name: 'x', list: ['a'] }, 0)).toEqual({
      id: 7,
      ok: true,
      name: maskFull(),
      list: [maskFull()],
    });
  });

  it('keeps a Date, bounds depth and survives a throwing getter', () => {
    const date = new Date();
    expect(maskEverything({ date }, 0)).toEqual({ date });
    expect(maskEverything({ a: 1 }, MAX_RESPONSE_DEPTH + 1)).toBeUndefined();
    expect(
      maskEverything(
        {
          get boom(): string {
            throw new Error('nope');
          },
        },
        0,
      ),
    ).toEqual({ boom: maskFull() });
  });
});

describe('attachRevealable', () => {
  it('adds a sorted list to an object envelope', () => {
    expect(attachRevealable({ data: 1 }, new Set(['b.c.d', 'a.b.c']))).toEqual({
      data: 1,
      [REVEALABLE_FIELDS_KEY]: ['a.b.c', 'b.c.d'],
    });
  });

  it('changes nothing when there is nothing to advertise, or the body is not an envelope', () => {
    expect(attachRevealable({ data: 1 }, new Set())).toEqual({ data: 1 });
    expect(attachRevealable([1], new Set(['a.b.c']))).toEqual([1]);
    expect(attachRevealable(null, new Set(['a.b.c']))).toBeNull();
    expect(attachRevealable('text', new Set(['a.b.c']))).toBe('text');
  });
});
