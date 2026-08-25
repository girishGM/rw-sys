/**
 * T-035 — `UsersService`: the role-creation matrix, scope derivation, listing, patching,
 * deactivation and admin-initiated password reset.
 *
 * The property under test throughout is *"which decision was made, and on what basis"* — the
 * real rows are `ScopedRepository`'s and `scope-strategy.ts`'s to prove (T-013, 100% branch
 * coverage there already). Negative-authorisation (R6) and, above all, the **escalation** tests
 * this task's own file flags as mandatory (TC-2, TC-3, TC-5, TC-6, TC-8, TC-9, TC-10, TC-11,
 * TC-12) are proven directly here at the service layer, the third of the module's three
 * independent layers — not only inferred from controller metadata.
 */
import { UniqueConstraintError } from 'sequelize';
import { Country, Merchant, Tenant } from '@/database/models';
import { PortalUser, type PortalRole } from '@/database/portal-models';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { UsersService } from '@/modules/users/users.service';
import {
  CannotDeactivateSelfError,
  RoleChangeNotPermittedError,
  RoleCreationNotPermittedError,
  RoleManagementNotPermittedError,
  UserEmailExistsError,
  USER_ERROR_CODE,
} from '@/modules/users/users.errors';
import type { CreateUserDto } from '@/modules/users/dto/create-user.dto';
import type { UpdateUserDto } from '@/modules/users/dto/update-user.dto';
import {
  FakeAuditService,
  FakeCredentialService,
  FakeScopedRepository,
  FakeSequelize,
  FakeSessionService,
  FakeTemporaryPasswordService,
  actor,
  asAuditService,
  asCredentialService,
  asScopedRepository,
  asSequelize,
  asSessionService,
  asTemporaryPasswordService,
  countryRow,
  merchantRow,
  portalUserRow,
  requestContext,
  tenantRow,
} from './support/users-doubles';

function newUserDto(overrides: Partial<CreateUserDto> = {}): CreateUserDto {
  return {
    email: 'new.user@example.invalid',
    displayName: 'New User',
    role: 'maker',
    ...overrides,
  } as CreateUserDto;
}

describe('UsersService', () => {
  let scoped: FakeScopedRepository;
  let sequelize: FakeSequelize;
  let credentials: FakeCredentialService;
  let audit: FakeAuditService;
  let sessions: FakeSessionService;
  let temporaryPasswords: FakeTemporaryPasswordService;
  let service: UsersService;

  beforeEach(() => {
    scoped = new FakeScopedRepository();
    sequelize = new FakeSequelize();
    credentials = new FakeCredentialService();
    audit = new FakeAuditService();
    sessions = new FakeSessionService();
    temporaryPasswords = new FakeTemporaryPasswordService();
    service = new UsersService(
      asSequelize(sequelize),
      asScopedRepository(scoped),
      asCredentialService(credentials),
      asAuditService(audit),
      asSessionService(sessions),
      asTemporaryPasswordService(temporaryPasswords),
    );
  });

  // --- the creation matrix — mandatory escalation tests ---------------------------------------

  describe('create — the role-creation matrix', () => {
    it('TC-1: super_admin creates country_admin — allowed', async () => {
      scoped.setByPk(Country, countryRow({ id: 3 }));
      const who = actor({ role: 'super_admin', countryId: null, tenantId: null });

      const result = await service.create(who, newUserDto({ role: 'country_admin', countryId: 3 }));

      expect(result.role).toBe('country_admin');
      expect(result.countryId).toBe(3);
    });

    it('TC-2: super_admin creating another super_admin is refused — CLI only', async () => {
      const who = actor({ role: 'super_admin', countryId: null, tenantId: null });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'super_admin' }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleCreationNotPermittedError);
      expect((thrown as RoleCreationNotPermittedError).status).toBe(403);
      expect((thrown as RoleCreationNotPermittedError).code).toBe(
        USER_ERROR_CODE.ROLE_CREATION_NOT_PERMITTED,
      );
    });

    it('TC-3: super_admin creating a maker is refused — not adjacent in the chain', async () => {
      const who = actor({ role: 'super_admin', countryId: null, tenantId: null });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'maker' }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleCreationNotPermittedError);
    });

    it('TC-4: country_admin creates tenant_admin — allowed, own country', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10, countryId: 5 }));
      const who = actor({ role: 'country_admin', countryId: 5, tenantId: null });

      const result = await service.create(who, newUserDto({ role: 'tenant_admin', tenantId: 10 }));

      expect(result.role).toBe('tenant_admin');
      expect(result.countryId).toBe(5);
      expect(result.tenantId).toBe(10);
    });

    it('TC-5: country_admin creating another country_admin is refused', async () => {
      const who = actor({ role: 'country_admin', countryId: 5, tenantId: null });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'country_admin' }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleCreationNotPermittedError);
    });

    it('TC-6: country_admin creating a maker is refused', async () => {
      const who = actor({ role: 'country_admin', countryId: 5, tenantId: null });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'maker' }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleCreationNotPermittedError);
    });

    it.each(['maker', 'checker', 'merchant'] as const)(
      'TC-7: tenant_admin creates %s — allowed',
      async (role) => {
        if (role === 'merchant') scoped.setByPk(Merchant, merchantRow({ id: 20, tenantId: 10 }));
        const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });

        const result = await service.create(
          who,
          newUserDto({ role, ...(role === 'merchant' ? { merchantId: 20 } : {}) }),
        );

        expect(result.role).toBe(role);
        expect(result.tenantId).toBe(10);
      },
    );

    it('TC-8: tenant_admin creating another tenant_admin is refused', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'tenant_admin' }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleCreationNotPermittedError);
    });

    it('TC-9: maker creating any user is refused', async () => {
      const who = actor({ role: 'maker', countryId: 1, tenantId: 10 });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'maker' }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleCreationNotPermittedError);
    });

    it.each(['checker', 'merchant'] as const)(
      'TC-10: %s creating any user is refused',
      async (role) => {
        const who = actor({ role, countryId: 1, tenantId: 10 });
        const thrown: unknown = await service
          .create(who, newUserDto({ role: 'maker' }))
          .catch((error: unknown) => error);

        expect(thrown).toBeInstanceOf(RoleCreationNotPermittedError);
      },
    );

    it("TC-11: a tenantId in the body is ignored — the row is created in the actor's own tenant", async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });

      const result = await service.create(
        who,
        newUserDto({ role: 'maker', tenantId: 999 } as Partial<CreateUserDto>),
      );

      expect(result.tenantId).toBe(10);
      const created = scoped.callsTo('create').find((call) => call.model === 'PortalUser');
      expect((created?.values as { tenantId: number }).tenantId).toBe(10);
    });

    it('TC-12: role: super_admin in the body while the actor may only create a maker — 403 by the matrix', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'super_admin' as PortalRole }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleCreationNotPermittedError);
    });

    it('TC-13: a merchantId from another tenant 404s — no row created', async () => {
      scoped.setByPk(Merchant, null); // out of the actor's tenant scope
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });

      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'merchant', merchantId: 777 }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ScopeViolationError);
      expect(scoped.callsTo('create').find((call) => call.model === 'PortalUser')).toBeUndefined();
    });

    it('TC-14: creating a merchant with no merchantId is a 400', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'merchant' }))
        .catch((error: unknown) => error);

      expect((thrown as { status: number }).status).toBe(400);
      expect((thrown as { details: unknown }).details).toEqual([
        { field: 'merchantId', code: 'REQUIRED' },
      ]);
    });

    it('creating a country_admin with no countryId is a 400', async () => {
      const who = actor({ role: 'super_admin', countryId: null, tenantId: null });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'country_admin' }))
        .catch((error: unknown) => error);

      expect((thrown as { status: number }).status).toBe(400);
      expect((thrown as { details: unknown }).details).toEqual([
        { field: 'countryId', code: 'REQUIRED' },
      ]);
    });

    it('creating a tenant_admin with no tenantId is a 400', async () => {
      const who = actor({ role: 'country_admin', countryId: 5, tenantId: null });
      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'tenant_admin' }))
        .catch((error: unknown) => error);

      expect((thrown as { status: number }).status).toBe(400);
      expect((thrown as { details: unknown }).details).toEqual([
        { field: 'tenantId', code: 'REQUIRED' },
      ]);
    });

    it('a countryId belonging to another country_admin is out of scope — never reached: super_admin has no country of its own to compare against, so existence alone is checked', async () => {
      scoped.setByPk(Country, null);
      const who = actor({ role: 'super_admin', countryId: null, tenantId: null });

      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'country_admin', countryId: 999 }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ScopeViolationError);
    });

    it("a tenantId outside the country_admin's own country 404s (the Tenant-side TC-13 equivalent)", async () => {
      scoped.setByPk(Tenant, null);
      const who = actor({ role: 'country_admin', countryId: 5, tenantId: null });

      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'tenant_admin', tenantId: 999 }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ScopeViolationError);
    });

    it('deriveTargetScope refuses defensively for a role with no scope-derivation case — unreachable via the public API (assertCreationAllowed always throws first for maker/checker/merchant), exercised directly for exhaustiveness', async () => {
      const who = actor({ role: 'maker', countryId: 1, tenantId: 10 });
      const dto = newUserDto({ role: 'maker' });

      type PrivateDeriveTargetScope = (
        callingActor: AuthenticatedUser,
        dto: CreateUserDto,
        transaction: unknown,
      ) => Promise<unknown>;
      const privateService = service as unknown as {
        deriveTargetScope: PrivateDeriveTargetScope;
      };

      const thrown: unknown = await privateService
        .deriveTargetScope(who, dto, {})
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleCreationNotPermittedError);
    });
  });

  // --- create — mechanics ----------------------------------------------------------------------

  describe('create — mechanics', () => {
    it('TC-15: a duplicate email maps to 409 USER_EMAIL_EXISTS', async () => {
      scoped.failNextCreate(
        PortalUser,
        new UniqueConstraintError({ message: 'uq_portal_users_email_live' }),
      );
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });

      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'maker' }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(UserEmailExistsError);
      expect((thrown as UserEmailExistsError).status).toBe(409);
    });

    it('an unrelated database error from the insert is rethrown unchanged, not mapped to USER_EMAIL_EXISTS', async () => {
      const dbError = new Error('connection reset');
      scoped.failNextCreate(PortalUser, dbError);
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });

      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'maker' }))
        .catch((error: unknown) => error);

      expect(thrown).toBe(dbError);
    });

    it('TC-16: the response carries a temporary password and no hash or activation token field', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      const result = await service.create(who, newUserDto({ role: 'maker' }));

      expect(typeof result.temporaryPassword).toBe('string');
      expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(24);
      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('activationToken');
    });

    it("new users are created active, with mustChangePassword true (this file's own header)", async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      const result = await service.create(who, newUserDto({ role: 'maker' }));

      expect(result.status).toBe('active');
      expect(result.mustChangePassword).toBe(true);
    });

    it('inserts the credential row via raw SQL, never through ScopedRepository (the deny() bug this task avoids)', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      const result = await service.create(who, newUserDto({ role: 'maker' }));

      expect(scoped.callsTo('create').some((call) => call.model === 'PortalUserCredential')).toBe(
        false,
      );
      expect(sequelize.queries).toHaveLength(1);
      expect(sequelize.queries[0].sql).toMatch(/portal_user_credentials/);
      const replacements = (
        sequelize.queries[0].options as { replacements: { passwordHash: string } }
      ).replacements;
      expect(replacements.passwordHash).toBe(`argon2id-hash-of:${result.temporaryPassword}`);
    });

    it('runs inside one transaction', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      await service.create(who, newUserDto({ role: 'maker' }));
      expect(sequelize.transactionCalls).toBe(1);
    });

    it('annotates the audit context with the created user id', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      const result = await service.create(who, newUserDto({ role: 'maker' }));
      expect(audit.annotations).toContainEqual({ targetId: result.id });
    });

    // --- T-046: generation, expiry and the disclosure audit event -----------------------------

    it('T-046: generates through TemporaryPasswordService, before the transaction opens — a throttled admin leaves no partial row', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      const result = await service.create(who, newUserDto({ role: 'maker' }));

      expect(temporaryPasswords.generateCalls).toEqual([who]);
      expect(result.temporaryPassword).toBe(temporaryPasswords.nextPassword);
    });

    it('T-046 TC-16: a rate-limited generation is rethrown and no row is ever created', async () => {
      const boom = new Error('rate limited');
      temporaryPasswords.generateError = boom;
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });

      const thrown: unknown = await service
        .create(who, newUserDto({ role: 'maker' }))
        .catch((error: unknown) => error);

      expect(thrown).toBe(boom);
      expect(sequelize.transactionCalls).toBe(0);
      expect(scoped.callsTo('create')).toHaveLength(0);
    });

    it("T-046: insertCredential's SQL carries the issued expiry (implementation note 5)", async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      await service.create(who, newUserDto({ role: 'maker' }));

      const replacements = (
        sequelize.queries[0].options as { replacements: { passwordExpiresAt: Date } }
      ).replacements;
      expect(replacements.passwordExpiresAt).toBe(temporaryPasswords.nextExpiresAt);
    });

    it('T-046 TC-8: records temporary_password_issued once, after the transaction commits, for the created user', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      const result = await service.create(who, newUserDto({ role: 'maker' }));

      expect(temporaryPasswords.issued).toEqual([{ actor: who, targetUserId: result.id }]);
    });

    // --- T-101: create() must not return the raw insert result -------------------------------
    //
    // `PortalUser.email` only decrypts through the `afterFind` hook (`model-encryption.hooks.ts`);
    // `scoped.create()`'s post-INSERT return value never goes through it, so a service that hands
    // that value straight to the response DTO leaks the ciphertext envelope. Proven here the same
    // way the rest of this file proves a decision without a real database: `scoped.create()` is
    // made to return a row distinguishable from what a reload (`findByPkOrFail`) would return, and
    // the test asserts the response carries the *reloaded* value.
    it('T-101: reloads the row via findByPkOrFail before building the response, so a field that only decrypts on read is never taken from the raw insert result', async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      // Stands in for the decrypted value `afterFind` would have produced on a real reload.
      scoped.setByPk(
        PortalUser,
        portalUserRow({ id: 500, email: 'decrypted.reload@example.invalid' }),
      );
      // Stands in for the raw, still-ciphertext row `scoped.create()`'s bare INSERT result is in
      // production — never touched by `afterFind`.
      jest
        .spyOn(scoped, 'create')
        .mockResolvedValueOnce(
          portalUserRow({ id: 500, email: 'v1.k1.iv.tag.rawciphertextenvelope' }) as never,
        );

      const result = await service.create(who, newUserDto({ role: 'maker' }));

      expect(result.email).toBe('decrypted.reload@example.invalid');
      expect(result.email).not.toBe('v1.k1.iv.tag.rawciphertextenvelope');
      expect(scoped.callsTo('findByPkOrFail').some((call) => call.model === 'PortalUser')).toBe(
        true,
      );
    });

    it("T-101 adjacent behaviour: the response's id and audit annotation still come from the insert result, not the reload, when the two ids happen to differ (they never should in production, but the two lookups must not be conflated)", async () => {
      const who = actor({ role: 'tenant_admin', countryId: 1, tenantId: 10 });
      scoped.setByPk(PortalUser, portalUserRow({ id: 500 }));
      jest.spyOn(scoped, 'create').mockResolvedValueOnce(portalUserRow({ id: 500 }) as never);

      const result = await service.create(who, newUserDto({ role: 'maker' }));

      expect(audit.annotations).toContainEqual({ targetId: 500 });
      expect(temporaryPasswords.issued).toEqual([{ actor: who, targetUserId: result.id }]);
    });
  });

  // --- list / getById -----------------------------------------------------------------------

  describe('list', () => {
    it('TC-17/TC-18: lists through ScopedRepository, so scope applies untouched', async () => {
      scoped.setListRows(PortalUser, [portalUserRow()]);
      scoped.setCount(PortalUser, 1);

      const { rows, meta } = await service.list({});

      expect(rows).toHaveLength(1);
      expect(meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    });

    it('TC-29: a listed row carries no password_hash or mfa_secret_enc field', async () => {
      scoped.setListRows(PortalUser, [portalUserRow()]);
      scoped.setCount(PortalUser, 1);

      const { rows } = await service.list({});

      expect(rows[0]).not.toHaveProperty('passwordHash');
      expect(rows[0]).not.toHaveProperty('mfaSecretEnc');
    });

    it('defaults to displayName:asc when no sort is given', async () => {
      await service.list({});
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ order: [['displayName', 'ASC']] });
    });

    it('parses an explicit sort', async () => {
      await service.list({ sort: 'createdAt:desc' });
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ order: [['createdAt', 'DESC']] });
    });

    it('caps pageSize at 100 rather than rejecting a larger request', async () => {
      await service.list({ pageSize: 500 });
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ limit: 100 });
    });
  });

  describe('getById', () => {
    it('returns the row scope allowed through', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 7 }));
      const dto = await service.getById(7);
      expect(dto.id).toBe(7);
    });

    it('TC-19: 404s for a user out of the actor\'s scope — indistinguishable from "does not exist"', async () => {
      scoped.setByPk(PortalUser, null);
      const thrown: unknown = await service.getById(999).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(ScopeViolationError);
    });
  });

  // --- update (PATCH) ------------------------------------------------------------------------

  describe('update', () => {
    it('writes only displayName', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 7 }));
      await service.update(actor(), 7, { displayName: 'Renamed' } as UpdateUserDto);

      const call = scoped.callsTo('update')[0];
      expect(call.values).toEqual({ displayName: 'Renamed' });
    });

    it("TC-20: 404s for a user out of the actor's scope; nothing is written", async () => {
      scoped.setByPk(PortalUser, null);
      const thrown: unknown = await service
        .update(actor(), 999, { displayName: 'Renamed' } as UpdateUserDto)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ScopeViolationError);
      expect(scoped.callsTo('update')).toHaveLength(0);
    });

    it('TC-28: a role field on the body is refused outright, even before touching the row', async () => {
      const thrown: unknown = await service
        .update(actor(), 7, { role: 'tenant_admin' } as UpdateUserDto)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleChangeNotPermittedError);
      expect((thrown as RoleChangeNotPermittedError).status).toBe(403);
      expect(scoped.callsTo('findByPkOrFail')).toHaveLength(0);
    });

    it('refuses a role field even when it equals the current role — no role transition at all, not only escalating ones', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 7, role: 'maker' }));
      const thrown: unknown = await service
        .update(actor(), 7, { role: 'maker' } as UpdateUserDto)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleChangeNotPermittedError);
    });

    // --- T-088/F-12: the role-management floor ------------------------------------------------

    it('T-088: a tenant_admin renaming its own maker is allowed — the row is in ALLOWED_CREATION', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 7, role: 'maker' }));
      const who = actor({ role: 'tenant_admin' });

      await service.update(who, 7, { displayName: 'Renamed' } as UpdateUserDto);

      expect(scoped.callsTo('update')).toHaveLength(1);
    });

    it('T-088/F-12: an over-granted maker renaming its own tenant_admin is refused — the exact escalation measured by T-051', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 9, role: 'tenant_admin' }));
      const who = actor({ role: 'maker' });

      const thrown: unknown = await service
        .update(who, 9, { displayName: 'Escalation probe' } as UpdateUserDto)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleManagementNotPermittedError);
      expect((thrown as RoleManagementNotPermittedError).status).toBe(403);
      expect((thrown as RoleManagementNotPermittedError).code).toBe(
        USER_ERROR_CODE.ROLE_MANAGEMENT_NOT_PERMITTED,
      );
      expect(scoped.callsTo('update')).toHaveLength(0);
    });

    it('T-088: a tenant_admin cannot rename a peer tenant_admin, including itself — no role is adjacent to itself in the matrix', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 1, role: 'tenant_admin' }));
      const who = actor({ userId: 1, role: 'tenant_admin' });

      const thrown: unknown = await service
        .update(who, 1, { displayName: 'Self rename' } as UpdateUserDto)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleManagementNotPermittedError);
      expect(scoped.callsTo('update')).toHaveLength(0);
    });
  });

  // --- deactivate ------------------------------------------------------------------------------

  describe('deactivate', () => {
    it('TC-21: sets status inactive and revokes every session for the target', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 7 }));
      const who = actor({ userId: 1 });

      const result = await service.deactivate(who, 7, requestContext());

      expect(result.status).toBe('inactive');
      expect(sessions.revocations).toHaveLength(1);
      expect(sessions.revocations[0]).toMatchObject({ userId: 7, exceptSessionId: null });
    });

    it('TC-23: a user deactivating themselves is refused with 422 CANNOT_DEACTIVATE_SELF', async () => {
      const who = actor({ userId: 7 });
      const thrown: unknown = await service
        .deactivate(who, 7, requestContext())
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(CannotDeactivateSelfError);
      expect((thrown as CannotDeactivateSelfError).status).toBe(422);
      expect((thrown as CannotDeactivateSelfError).code).toBe(
        USER_ERROR_CODE.CANNOT_DEACTIVATE_SELF,
      );
      expect(scoped.callsTo('findByPkOrFail')).toHaveLength(0);
      expect(sessions.revocations).toHaveLength(0);
    });

    it("404s for a target out of the actor's scope; no session revocation happens", async () => {
      scoped.setByPk(PortalUser, null);
      const who = actor({ userId: 1 });

      const thrown: unknown = await service
        .deactivate(who, 999, requestContext())
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ScopeViolationError);
      expect(sessions.revocations).toHaveLength(0);
    });

    // --- T-088/F-12: the role-management floor ------------------------------------------------

    it('T-088/F-12: an over-granted maker deactivating its own tenant_admin is refused — no row is touched, no session revoked', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 9, role: 'tenant_admin' }));
      const who = actor({ userId: 1, role: 'maker' });

      const thrown: unknown = await service
        .deactivate(who, 9, requestContext())
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleManagementNotPermittedError);
      expect((thrown as RoleManagementNotPermittedError).status).toBe(403);
      expect((thrown as RoleManagementNotPermittedError).code).toBe(
        USER_ERROR_CODE.ROLE_MANAGEMENT_NOT_PERMITTED,
      );
      expect(scoped.callsTo('update')).toHaveLength(0);
      expect(sessions.revocations).toHaveLength(0);
    });
  });

  // --- reset-password --------------------------------------------------------------------------

  describe('resetPassword', () => {
    it('TC-24: issues a new password once and revokes every session for the target', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 7, email: 'target@example.invalid' }));
      const who = actor({ userId: 1 });

      const result = await service.resetPassword(who, 7, requestContext());

      expect(typeof result.temporaryPassword).toBe('string');
      expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(24);
      expect(credentials.changePasswordCalls).toHaveLength(1);
      expect(credentials.changePasswordCalls[0]).toMatchObject({
        userId: 7,
        email: 'target@example.invalid',
        newPassword: result.temporaryPassword,
      });
      expect(credentials.changePasswordCalls[0].currentPassword).toBeUndefined();
      expect(sessions.revocations).toHaveLength(1);
      expect(sessions.revocations[0]).toMatchObject({ userId: 7, exceptSessionId: null });
    });

    it('sets mustChangePassword back to true', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 7, mustChangePassword: false }));
      const who = actor({ userId: 1 });

      const result = await service.resetPassword(who, 7, requestContext());

      expect(result.mustChangePassword).toBe(true);
    });

    it("TC-23-equivalent scope check: 404s for a target out of the actor's scope", async () => {
      scoped.setByPk(PortalUser, null);
      const who = actor({ userId: 1 });

      const thrown: unknown = await service
        .resetPassword(who, 999, requestContext())
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ScopeViolationError);
      expect(sessions.revocations).toHaveLength(0);
    });

    // --- T-046: generation, expiry and the disclosure audit event -----------------------------

    it('T-046 TC-13: reissues through TemporaryPasswordService — a new password, a new expiry window', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 7, email: 'target@example.invalid' }));
      const who = actor({ userId: 1 });

      const result = await service.resetPassword(who, 7, requestContext());

      expect(temporaryPasswords.generateCalls).toEqual([who]);
      expect(result.temporaryPassword).toBe(temporaryPasswords.nextPassword);
      expect(temporaryPasswords.expirySets).toEqual([
        { userId: 7, expiresAt: temporaryPasswords.nextExpiresAt },
      ]);
    });

    it('T-046 TC-16: a rate-limited reissue is rethrown; no session is revoked and nothing is written', async () => {
      const boom = new Error('rate limited');
      temporaryPasswords.generateError = boom;
      scoped.setByPk(PortalUser, portalUserRow({ id: 7 }));
      const who = actor({ userId: 1 });

      const thrown: unknown = await service
        .resetPassword(who, 7, requestContext())
        .catch((error: unknown) => error);

      expect(thrown).toBe(boom);
      expect(sequelize.transactionCalls).toBe(0);
      expect(credentials.changePasswordCalls).toHaveLength(0);
      expect(sessions.revocations).toHaveLength(0);
    });

    it('T-046 TC-8/TC-15: records temporary_password_issued for the target, and still revokes every session', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 7 }));
      const who = actor({ userId: 1, role: 'tenant_admin' });

      await service.resetPassword(who, 7, requestContext());

      expect(temporaryPasswords.issued).toEqual([{ actor: who, targetUserId: 7 }]);
      expect(sessions.revocations).toHaveLength(1);
      expect(sessions.revocations[0]).toMatchObject({ userId: 7, exceptSessionId: null });
    });

    // --- T-088/F-12: the role-management floor ------------------------------------------------

    /**
     * The exact scenario `layer-two-exposure.e2e-spec.ts` measures end to end (F-12's headline
     * case): an over-granted `maker` resetting its own `tenant_admin`'s password. The database
     * fact that matters is that `changePassword()`/session revocation are never reached — a
     * disclosed password is the whole finding, so this asserts absence of both, not just the
     * thrown type.
     */
    it('T-088/F-12: an over-granted maker resetting its own tenant_admin’s password is refused — no credential write, no disclosure, no session revoked', async () => {
      scoped.setByPk(PortalUser, portalUserRow({ id: 9, role: 'tenant_admin' }));
      const who = actor({ userId: 1, role: 'maker' });

      const thrown: unknown = await service
        .resetPassword(who, 9, requestContext())
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(RoleManagementNotPermittedError);
      expect((thrown as RoleManagementNotPermittedError).status).toBe(403);
      expect((thrown as RoleManagementNotPermittedError).code).toBe(
        USER_ERROR_CODE.ROLE_MANAGEMENT_NOT_PERMITTED,
      );
      expect(credentials.changePasswordCalls).toHaveLength(0);
      expect(temporaryPasswords.issued).toHaveLength(0);
      expect(sessions.revocations).toHaveLength(0);
    });

    it('T-088: a country_admin resetting its own tenant_admin’s password is still allowed — the fix does not narrow legitimate delegation', async () => {
      scoped.setByPk(
        PortalUser,
        portalUserRow({ id: 9, role: 'tenant_admin', email: 't@example.invalid' }),
      );
      const who = actor({ userId: 1, role: 'country_admin', tenantId: null });

      const result = await service.resetPassword(who, 9, requestContext());

      expect(typeof result.temporaryPassword).toBe('string');
      expect(credentials.changePasswordCalls).toHaveLength(1);
    });
  });
});
