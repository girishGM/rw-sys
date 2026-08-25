/**
 * T-015 — `MeService`: reading the caller's own row, and the three fields of it they may write.
 *
 * TC-16 and TC-17 are usually thought of as validation tests — `{"role":"super_admin"}` → 400 —
 * and they are asserted that way over HTTP in `me.e2e-spec.ts`. This suite asserts the layer
 * *behind* the validation: that even when a value reaches the service, only three named fields are
 * ever passed to the update, and the WHERE clause names the caller's own id.
 *
 * That distinction matters because the two layers fail independently. `forbidNonWhitelisted` is a
 * global pipe option in `main.ts` — a file this task does not own — and a future change there
 * would silently turn a 400 into a stripped field. If that ever happens, the DTO whitelist and the
 * explicit field loop below are what stop it becoming a privilege escalation, and they are only
 * worth anything if they are tested without the pipe in front of them.
 */
import { MeService, scopeOf, toProfile } from '@/modules/me/me.service';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import { PortalUser } from '@/database/portal-models';
import type { UpdateMeDto } from '@/modules/me/dto/me-request.dto';
import {
  FakeAuditService,
  FakeScopedRepository,
  actor,
  asAuditService,
  asScopedRepository,
  userRow,
} from './support/me-doubles';
import { expectNoSecretMaterial } from './support/secret-scan';

describe('MeService', () => {
  let scoped: FakeScopedRepository;
  let audit: FakeAuditService;
  let service: MeService;

  beforeEach(() => {
    scoped = new FakeScopedRepository();
    scoped.self = userRow();
    audit = new FakeAuditService();
    service = new MeService(asScopedRepository(scoped), asAuditService(audit));
  });

  describe('findSelf', () => {
    it('reads through ScopedRepository, by the token’s userId (R2, R3)', async () => {
      await service.findSelf(actor({ userId: 42 }));

      const call = scoped.callsTo('findByPkOrFail')[0];
      expect(call.model).toBe(PortalUser.name);
      expect(call.options).toMatchObject({ id: 42 });
    });

    it('404s rather than inventing an empty profile when the row is gone', async () => {
      scoped.self = null;

      const thrown: unknown = await service.findSelf(actor()).catch((error: unknown) => error);

      // T-013's one sanctioned scope failure: 404 `NOT_FOUND`, carrying no discriminator between
      // "no such row" and "out of scope" (02-SECURITY.md §5.1).
      expect(thrown).toBeInstanceOf(ScopeViolationError);
      expect((thrown as ScopeViolationError).getStatus()).toBe(404);
      expect((thrown as ScopeViolationError).getResponse()).toEqual({
        error: { code: 'NOT_FOUND' },
      });
    });
  });

  describe('getProfile', () => {
    it('returns the caller’s own profile', async () => {
      const profile = await service.getProfile(actor());

      expect(profile).toEqual({
        id: 12,
        email: 'maker@example.invalid',
        displayName: 'A Maker',
        role: 'maker',
        scope: { countryId: 3, tenantId: 7, merchantId: null },
        locale: 'en',
        timezone: 'Asia/Kolkata',
        status: 'active',
        mustChangePassword: false,
        lastLoginAt: '2026-08-17T09:00:00.000Z',
      });
    });

    it('carries no credential, session or MFA material at any depth (TC-15)', async () => {
      // The row `findSelf` returns carries `password`-adjacent and `mfa_secret_enc` columns in
      // production; the profile is built as a fresh literal, so none of them can travel. See
      // `support/secret-scan.ts` for why this walks keys rather than grepping the JSON.
      expectNoSecretMaterial(await service.getProfile(actor()));
    });

    it('the scan is not vacuous — it catches a leaked column if one is ever added', () => {
      expect(() => expectNoSecretMaterial({ user: { mfaSecretEnc: 'ciphertext' } })).toThrow();
    });
  });

  describe('updateProfile', () => {
    it('writes exactly the fields that were supplied', async () => {
      await service.updateProfile(actor(), { displayName: 'New Name' });

      const call = scoped.callsTo('update')[0];
      expect(call.values).toEqual({ displayName: 'New Name' });
    });

    it('writes all three when all three are supplied', async () => {
      const dto: UpdateMeDto = {
        displayName: 'New',
        preferredLocale: 'fr-CA',
        preferredTimezone: 'Europe/Paris',
      };

      await service.updateProfile(actor(), dto);

      expect(scoped.callsTo('update')[0].values).toEqual(dto);
    });

    it('constrains the update to the caller’s own row', async () => {
      await service.updateProfile(actor({ userId: 42 }), { displayName: 'New' });

      const call = scoped.callsTo('update')[0];
      expect(call.model).toBe(PortalUser.name);
      expect(call.options).toEqual({ where: { id: 42 } });
    });

    it('TC-16: forwards no `role`, even when one reaches the service', async () => {
      // The pipe rejects this body with a 400 long before here (asserted over HTTP in the e2e).
      // The cast is what a *broken* pipe would effectively produce, and the assertion is that the
      // service is not the layer that would then escalate.
      const smuggled = { displayName: 'New', role: 'super_admin' } as unknown as UpdateMeDto;

      await service.updateProfile(actor(), smuggled);

      expect(scoped.callsTo('update')[0].values).toEqual({ displayName: 'New' });
    });

    it('TC-17: forwards no scope field either', async () => {
      const smuggled = {
        preferredLocale: 'en',
        tenantId: 999,
        countryId: 999,
        merchantId: 999,
        status: 'active',
        mustChangePassword: false,
      } as unknown as UpdateMeDto;

      await service.updateProfile(actor(), smuggled);

      expect(scoped.callsTo('update')[0].values).toEqual({ preferredLocale: 'en' });
    });

    it('issues no UPDATE at all for an empty patch, and still returns the profile', async () => {
      const profile = await service.updateProfile(actor(), {});

      expect(scoped.callsTo('update')).toHaveLength(0);
      expect(profile.displayName).toBe('A Maker');
    });

    it('404s when the update matches no row', async () => {
      scoped.affected = 0;

      await expect(service.updateProfile(actor(), { displayName: 'x' })).rejects.toMatchObject({
        status: 404,
      });
    });

    it('audits the field names that changed, never their values', async () => {
      await service.updateProfile(actor({ userId: 42 }), {
        displayName: 'Something Personal',
        preferredLocale: 'fr',
      });

      expect(audit.annotations).toEqual([
        { targetId: 42, detail: { fields: ['displayName', 'preferredLocale'] } },
      ]);
      expect(JSON.stringify(audit.annotations)).not.toContain('Something Personal');
    });

    it('records an empty field list for a no-op patch rather than skipping the annotation', async () => {
      await service.updateProfile(actor(), {});

      expect(audit.annotations).toEqual([{ targetId: 12, detail: { fields: [] } }]);
    });

    it('re-reads the row afterwards, so the response reflects what was stored', async () => {
      scoped.self = userRow({ displayName: 'Stored By The Database' });

      const profile = await service.updateProfile(actor(), { displayName: 'Whatever' });

      expect(profile.displayName).toBe('Stored By The Database');
    });
  });
});

describe('toProfile / scopeOf', () => {
  it('takes role and scope from the token, not the row', () => {
    const row = userRow();
    // A row whose role and scope disagree with the token's — the shape that exists for the
    // fifteen minutes between an administrative change and the next refresh (AR-04).
    Object.assign(row, { role: 'super_admin', countryId: 99, tenantId: 99, merchantId: 99 });

    const profile = toProfile(actor({ role: 'maker', countryId: 3, tenantId: 7 }), row);

    expect(profile.role).toBe('maker');
    expect(profile.scope).toEqual({ countryId: 3, tenantId: 7, merchantId: null });
  });

  it('reports mustChangePassword from the guard-refreshed actor, not the row', () => {
    const row = userRow({ mustChangePassword: false });

    expect(toProfile(actor({ mustChangePassword: true }), row).mustChangePassword).toBe(true);
  });

  it('reports a never-logged-in user’s lastLoginAt as null', () => {
    expect(toProfile(actor(), userRow({ lastLoginAt: null })).lastLoginAt).toBeNull();
  });

  it('falls back to the default locale for a null column', () => {
    expect(toProfile(actor(), userRow({ preferredLocale: null })).locale).toBe('en');
  });

  it('scopeOf reports all three axes, including nulls', () => {
    expect(scopeOf(actor({ countryId: null, tenantId: null, merchantId: null }))).toEqual({
      countryId: null,
      tenantId: null,
      merchantId: null,
    });
  });
});
