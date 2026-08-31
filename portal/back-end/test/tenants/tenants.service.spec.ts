/**
 * T-034 — `TenantsService`: tenant onboarding, Tenant Admin onboarding, activation, budget
 * ceilings and the suspension session-revocation side effect.
 *
 * The property under test throughout is *"which decision was made, and on what basis"* — the
 * real rows are `ScopedRepository`'s and `scope-strategy.ts`'s to prove (T-013, 100% branch
 * coverage there already). Negative-authorisation (R6, TC-6/TC-7/TC-9/TC-24) is proven directly
 * here at the service layer — the third of this module's own three independent layers — rather
 * than only inferred from controller metadata.
 */
import { UniqueConstraintError } from 'sequelize';
import { Country, Tenant, TenantBudgetCeiling, TenantCurrency } from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { TenantsService } from '@/modules/tenants/tenants.service';
import type { TenantAdminCreatedDto } from '@/modules/tenants/dto/tenant-response.dto';
import {
  TenantAdminEmailExistsError,
  TenantAlreadyActiveError,
  TenantCodeExistsError,
  TenantSchemaPrefixExistsError,
} from '@/modules/tenants/tenants.errors';
import type { CreateTenantAdminDto } from '@/modules/tenants/dto/create-tenant-admin.dto';
import type { CreateTenantDto } from '@/modules/tenants/dto/create-tenant.dto';
import type { UpdateTenantDto } from '@/modules/tenants/dto/update-tenant.dto';
import type { UpsertBudgetCeilingDto } from '@/modules/tenants/dto/upsert-budget-ceiling.dto';
import {
  FakeAuditService,
  FakeCredentialProvisioner,
  FakeCredentialService,
  FakeScopedRepository,
  FakeSequelize,
  FakeSessionService,
  actor,
  asAuditService,
  asCredentialProvisioner,
  asCredentialService,
  asScopedRepository,
  asSequelize,
  asSessionService,
  budgetCeilingRow,
  countryRow,
  portalUserRow,
  requestContext,
  tenantRow,
} from './support/tenants-doubles';

function newTenantDto(overrides: Partial<CreateTenantDto> = {}): CreateTenantDto {
  return { code: 'T001', name: 'Acme Retail', ...overrides } as CreateTenantDto;
}

function newAdminDto(overrides: Partial<CreateTenantAdminDto> = {}): CreateTenantAdminDto {
  return {
    email: 'tenant.admin@example.invalid',
    displayName: 'New Tenant Admin',
    ...overrides,
  } as CreateTenantAdminDto;
}

function newCeilingDto(overrides: Partial<UpsertBudgetCeilingDto> = {}): UpsertBudgetCeilingDto {
  return {
    unitType: 'currency',
    unitCode: 'MYR',
    maxCampaignBudget: '5000000',
    ...overrides,
  } as UpsertBudgetCeilingDto;
}

describe('TenantsService', () => {
  let scoped: FakeScopedRepository;
  let sequelize: FakeSequelize;
  let credentials: FakeCredentialService;
  let credentialStore: FakeCredentialProvisioner;
  let audit: FakeAuditService;
  let sessions: FakeSessionService;
  let service: TenantsService;

  beforeEach(() => {
    scoped = new FakeScopedRepository();
    // T-143: every `create()` call goes through `insertTenant`, which now looks up the tenant's
    // own country to seed its default currency row — seeded here, once, so every existing
    // `create`-path test below keeps working unchanged; tests that care about the country's own
    // shape (e.g. its `currencyCode`) override it explicitly with `scoped.setByPk(Country, …)`.
    scoped.setByPk(Country, countryRow());
    sequelize = new FakeSequelize();
    credentials = new FakeCredentialService();
    credentialStore = new FakeCredentialProvisioner();
    audit = new FakeAuditService();
    sessions = new FakeSessionService();
    service = new TenantsService(
      asSequelize(sequelize),
      asScopedRepository(scoped),
      asCredentialService(credentials),
      asCredentialProvisioner(credentialStore),
      asAuditService(audit),
      asSessionService(sessions),
    );
  });

  // --- list / getById -----------------------------------------------------------------------

  describe('list', () => {
    it('lists through ScopedRepository, so scope (country_admin → own country) applies untouched (TC-3)', async () => {
      scoped.setListRows(Tenant, [tenantRow()]);
      scoped.setCount(Tenant, 1);

      const { rows, meta } = await service.list({});

      expect(rows).toHaveLength(1);
      expect(meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    });

    it('defaults to name:asc when no sort is given', async () => {
      await service.list({});
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ order: [['name', 'ASC']] });
    });

    it('parses an explicit sort', async () => {
      await service.list({ sort: 'status:desc' });
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ order: [['status', 'DESC']] });
    });

    it('caps pageSize at 100 rather than rejecting a larger request', async () => {
      await service.list({ pageSize: 500 });
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ limit: 100 });
    });

    it('computes offset from page and pageSize', async () => {
      await service.list({ page: 3, pageSize: 10 });
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ limit: 10, offset: 20 });
    });
  });

  describe('getById', () => {
    it('returns the row scope allowed through', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 7 }));
      const dto = await service.getById(7);
      expect(dto.id).toBe(7);
    });

    it('404s — not found or out of scope, indistinguishable (TC-4, 02-SECURITY.md §5.1)', async () => {
      scoped.setByPk(Tenant, null);
      const thrown: unknown = await service.getById(999).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(ScopeViolationError);
      expect((thrown as ScopeViolationError).getStatus()).toBe(404);
    });
  });

  // --- create --------------------------------------------------------------------------------

  describe('create — negative authorisation (TC-6, TC-7, TC-9, AGENT-PROTOCOL R6)', () => {
    it.each(['super_admin', 'tenant_admin', 'maker', 'checker', 'merchant'] as const)(
      '%s is denied — assertRole fires before any query, transaction included',
      async (role) => {
        await expect(
          service.create(actor({ role, countryId: null }), newTenantDto()),
        ).rejects.toBeInstanceOf(PermissionDeniedHttpException);

        expect(sequelize.transactionCalls).toBe(0);
        expect(scoped.calls).toHaveLength(0);
      },
    );
  });

  describe('create', () => {
    it('creates the tenant as country_admin, status pending_provisioning (TC-1)', async () => {
      const result = await service.create(actor(), newTenantDto());

      expect(result.tenant).toMatchObject({
        code: 'T001',
        name: 'Acme Retail',
        status: 'pending_provisioning',
      });
      expect(result.admin).toBeNull();

      const call = scoped.callsTo('create').find((c) => c.model === Tenant.name);
      expect(call?.values).toMatchObject({ status: 'pending_provisioning' });
    });

    it('never reads a countryId off the dto — TenantsService has no such field to read (TC-2, note 2)', async () => {
      const dtoWithoutCountryId = newTenantDto();
      expect(
        (dtoWithoutCountryId as unknown as Record<string, unknown>)['countryId'],
      ).toBeUndefined();
      await service.create(actor(), dtoWithoutCountryId);
      const call = scoped.callsTo('create').find((c) => c.model === Tenant.name);
      expect((call?.values as Record<string, unknown> | undefined)?.['countryId']).toBeUndefined();
      // country_id is instead forced by ScopedRepository.create from the actor's own scope —
      // scope-strategy.spec.ts / scoped.repository.spec.ts prove that mechanism at 100% branch
      // coverage; this test proves TenantsService never supplies (or needs to supply) it itself.
    });

    it('audits the created tenant id', async () => {
      await service.create(actor(), newTenantDto());
      expect(audit.annotations[0]).toMatchObject({ targetId: expect.any(Number) });
    });

    it('maps a duplicate code to 409 TENANT_CODE_EXISTS, never the raw constraint name (TC-10)', async () => {
      scoped.failNextCreate(
        Tenant,
        new UniqueConstraintError({ message: 'uq_tenants_code' } as never),
      );

      await expect(service.create(actor(), newTenantDto())).rejects.toBeInstanceOf(
        TenantCodeExistsError,
      );
    });

    it('maps a duplicate schema_prefix to 409 TENANT_SCHEMA_PREFIX_EXISTS via error.fields (TC-11)', async () => {
      scoped.failNextCreate(
        Tenant,
        new UniqueConstraintError({ fields: { schema_prefix: 'acme' } } as never),
      );

      await expect(
        service.create(actor(), newTenantDto({ schemaPrefix: 'acme' })),
      ).rejects.toBeInstanceOf(TenantSchemaPrefixExistsError);
    });

    it('maps a duplicate schema_prefix conflict via the message fallback when fields is absent', async () => {
      scoped.failNextCreate(
        Tenant,
        new UniqueConstraintError({ message: 'uq_tenants_schema_prefix' } as never),
      );

      await expect(
        service.create(actor(), newTenantDto({ schemaPrefix: 'acme' })),
      ).rejects.toBeInstanceOf(TenantSchemaPrefixExistsError);
    });

    it('propagates any other failure from the tenant insert unchanged (not mapped to a business error)', async () => {
      scoped.failNextCreate(Tenant, new Error('unexpected database failure'));

      await expect(service.create(actor(), newTenantDto())).rejects.toThrow(
        'unexpected database failure',
      );
    });

    it('creates the tenant and its Tenant Admin in one transaction (TC-13)', async () => {
      const result = await service.create(
        actor(),
        newTenantDto({ admin: newAdminDto({ email: 'ta@example.invalid', displayName: 'TA' }) }),
      );

      expect(result.admin).toMatchObject({
        email: 'ta@example.invalid',
        displayName: 'TA',
        role: 'tenant_admin',
        tenantId: result.tenant.id,
      });
      expect(result.admin?.temporaryPassword).toEqual(expect.any(String));
      expect(result.admin?.temporaryPassword.length).toBeGreaterThanOrEqual(20);

      // T-059 (TC-2/TC-8): the credential no longer goes through `ScopedRepository.create` at
      // all — `PortalUserCredential` is `deny()` for every scoped role, so a call here would
      // always have thrown. `Tenant`, `TenantCurrency` (T-143) and `PortalUser` go through the
      // scoped path, in that order — the default currency row is seeded as part of tenant
      // creation itself, before admin provisioning ever starts.
      expect(scoped.callsTo('create').map((c) => c.model)).toEqual([
        Tenant.name,
        TenantCurrency.name,
        PortalUser.name,
      ]);
      // The credential is instead routed through `CredentialProvisioner` (the fix's own route).
      expect(credentialStore.created).toHaveLength(1);
      expect(credentialStore.created[0]).toMatchObject({
        userId: expect.any(Number),
        passwordAlgo: 'argon2id',
      });
      expect(credentialStore.created[0]?.passwordHash).toEqual(expect.any(String));
    });

    it('the credential carries the same user id the PortalUser insert produced (TC-2)', async () => {
      const result = await service.create(actor(), newTenantDto({ admin: newAdminDto() }));
      expect(credentialStore.created[0]?.userId).toBe(result.admin?.id);
    });

    it('the admin gets must_change_password=true, status active, tenant_admin role, and is created by the actor (TC-13)', async () => {
      await service.create(actor({ userId: 42 }), newTenantDto({ admin: newAdminDto() }));
      const call = scoped.callsTo('create').find((c) => c.model === PortalUser.name);
      expect(call?.values).toMatchObject({
        role: 'tenant_admin',
        status: 'active',
        mustChangePassword: true,
        createdBy: 42,
      });
    });

    it('the tenant, the user and the credential all share the same transaction handle (TC-14 — atomicity)', async () => {
      await service.create(actor(), newTenantDto({ admin: newAdminDto() }));
      const scopedTransactions = scoped
        .callsTo('create')
        .map((c) => (c.options as { transaction: unknown }).transaction);
      const credentialTransaction = credentialStore.created[0]?.transaction;

      const transactions = new Set([...scopedTransactions, credentialTransaction]);
      expect(transactions.size).toBe(1);
    });

    it('maps a duplicate admin email to 409 TENANT_ADMIN_EMAIL_EXISTS', async () => {
      scoped.failNextCreate(
        PortalUser,
        new UniqueConstraintError({ message: 'uq_portal_users_email_live' } as never),
      );

      await expect(
        service.create(actor(), newTenantDto({ admin: newAdminDto() })),
      ).rejects.toBeInstanceOf(TenantAdminEmailExistsError);
      // Never reached the credential step.
      expect(credentialStore.created).toHaveLength(0);
    });

    it('a failure creating the admin propagates out of the one transaction — tenant not created either, credential never attempted (TC-4)', async () => {
      scoped.failNextCreate(PortalUser, new Error('simulated failure mid-transaction'));

      await expect(service.create(actor(), newTenantDto({ admin: newAdminDto() }))).rejects.toThrow(
        'simulated failure mid-transaction',
      );
      expect(credentialStore.created).toHaveLength(0);
    });

    it('a failure inside the credential insert propagates out of the same transaction — no partial state left behind (TC-5)', async () => {
      credentialStore.failNext(new Error('simulated credential insert failure'));

      await expect(service.create(actor(), newTenantDto({ admin: newAdminDto() }))).rejects.toThrow(
        'simulated credential insert failure',
      );
      // The whole `create()` call is one `sequelize.transaction()` — the real rollback guarantee
      // this proves is Postgres's own (verified live in this task's Verification steps, step 3);
      // what this unit test proves is that the thrown error is not swallowed anywhere between
      // `createCredential` and the transaction boundary, which is the one thing this layer could
      // silently get wrong.
      expect(credentialStore.created).toHaveLength(0);
    });

    it('a super_admin actor provisioning a tenant admin also succeeds — the fixed route carries no role check of its own (TC-6)', async () => {
      // `provisionTenantAdmin` is private and reached only through `create`/`createAdmin`, both
      // gated `assertRole(actor, 'country_admin')` — so this calls it directly, the same way this
      // file's own header describes proving the third, service-layer, authorisation boundary
      // independently. The point of TC-6 is specifically that `CredentialProvisioner` (unlike the
      // `ScopedRepository.create` call it replaces) carries no actor/role at all, so nothing about
      // this route's *own* behaviour differs for a super_admin caller — `isDenied()`
      // (`scope-strategy.ts`) already exempts `super_admin` from every `deny()` rule including
      // `PortalUserCredential`'s, so this was never the row the original defect touched.
      const provision = service as unknown as {
        provisionTenantAdmin(
          tenantId: number,
          dto: CreateTenantAdminDto,
          actorArg: ReturnType<typeof actor>,
          transaction: unknown,
        ): Promise<TenantAdminCreatedDto>;
      };

      const result = await provision.provisionTenantAdmin(
        10,
        newAdminDto({ email: 'sa-provisioned@example.invalid' }),
        actor({ role: 'super_admin', countryId: null }),
        {},
      );

      expect(result.email).toBe('sa-provisioned@example.invalid');
      expect(credentialStore.created).toHaveLength(1);
    });
  });

  // --- T-143 — insertTenant seeds a default tenant_currencies row --------------------------

  describe('T-143 — a new tenant gets a default tenant_currencies row (TC-2)', () => {
    it('inserts one is_default=true, active row carrying the tenant’s own country’s currency', async () => {
      scoped.setByPk(Country, countryRow({ id: 7, currencyCode: 'SGD' }));

      await service.create(actor(), newTenantDto());

      const call = scoped.callsTo('create').find((c) => c.model === TenantCurrency.name);
      expect(call?.values).toMatchObject({
        currencyCode: 'SGD',
        isDefault: true,
        status: 'active',
      });
    });

    it('is not a hard-coded currency — a different country’s currency_code is what gets written', async () => {
      scoped.setByPk(Country, countryRow({ currencyCode: 'MYR' }));
      await service.create(actor(), newTenantDto());
      expect(
        scoped.callsTo('create').find((c) => c.model === TenantCurrency.name)?.values,
      ).toMatchObject({ currencyCode: 'MYR' });

      scoped.setByPk(Country, countryRow({ currencyCode: 'PHP' }));
      await service.create(actor(), newTenantDto({ code: 'T002' }));
      expect(
        scoped
          .callsTo('create')
          .filter((c) => c.model === TenantCurrency.name)
          .at(-1)?.values,
      ).toMatchObject({ currencyCode: 'PHP' });
    });

    it('carries the tenant id the Tenant insert just produced, not a stale or hard-coded one', async () => {
      const result = await service.create(actor(), newTenantDto());
      const call = scoped.callsTo('create').find((c) => c.model === TenantCurrency.name);
      expect((call?.values as Record<string, unknown> | undefined)?.['tenantId']).toBe(
        result.tenant.id,
      );
    });

    it('looks the tenant’s own country up through the scoped repository, never a hard-coded row (R3)', async () => {
      // `FakeScopedRepository.create()` (this suite's own fake, unlike the real `ScopedRepository`)
      // does not simulate `forcedWriteValues` merging `country_id` onto the returned `Tenant`
      // instance — that mechanism is `scope-strategy.spec.ts`/`scoped.repository.spec.ts`'s own
      // 100% branch-covered territory (this file's header, "never reads a countryId off the dto"
      // test, makes the same point). What this test proves at this layer is only that the lookup
      // goes through `this.scoped.findByPkOrFail(Country, …)` — i.e. through the one path scope
      // actually gets enforced on — rather than, say, `actor.countryId` read directly. The
      // *value* a `country_admin`'s own country id ends up being is proven against the real
      // database in `tenants.e2e-spec.ts`'s T-143 suite (`currencyCode: 'USD'`, this file's own
      // fixture country), which a fake cannot prove no matter how it is shaped.
      await service.create(actor(), newTenantDto());
      const call = scoped.callsTo('findByPkOrFail').find((c) => c.model === Country.name);
      expect(call).toBeDefined();
    });

    it('the Tenant, its default currency and (when requested) its admin all share one transaction (TC-14 shape, extended)', async () => {
      await service.create(actor(), newTenantDto({ admin: newAdminDto() }));
      const transactions = new Set(
        scoped.callsTo('create').map((c) => (c.options as { transaction: unknown }).transaction),
      );
      expect(transactions.size).toBe(1);
    });

    it('a failure inserting the default currency row propagates out of the transaction — no half-created tenant left behind', async () => {
      scoped.failNextCreate(TenantCurrency, new Error('simulated currency insert failure'));
      await expect(service.create(actor(), newTenantDto())).rejects.toThrow(
        'simulated currency insert failure',
      );
      // The admin step (and its credential) must never have been reached either.
      expect(credentialStore.created).toHaveLength(0);
    });

    it('creating a tenant with no nested admin still gets its default currency row (the bug this task fixes)', async () => {
      const result = await service.create(actor(), newTenantDto());
      expect(result.admin).toBeNull();
      const call = scoped.callsTo('create').find((c) => c.model === TenantCurrency.name);
      expect(call).toBeDefined();
      expect(call?.values).toMatchObject({ tenantId: result.tenant.id, isDefault: true });
    });
  });

  describe('T-059 — the fix does not touch the scope strategy (TC-9)', () => {
    it('PortalUserCredential is still deny() on every axis for every non-super_admin role', async () => {
      // Reads the real `scope-strategy.ts` directly — not a fake — because the point of TC-9 is
      // that this task's fix is entirely in the call site, and the guard `PortalUserCredential`
      // was always correctly protected by is left completely untouched.
      const { PortalUserCredential } = await import('@/database/portal-models');
      const { scopeStrategyFor, ruleForRole, isDenied } =
        await import('@/common/scope/scope-strategy');
      const strategy = scopeStrategyFor(PortalUserCredential);

      for (const role of [
        'country_admin',
        'tenant_admin',
        'maker',
        'checker',
        'merchant',
      ] as const) {
        expect(ruleForRole(strategy, role)).toMatchObject({ kind: 'deny' });
        expect(
          isDenied(PortalUserCredential, {
            role,
            countryId: 1,
            tenantId: 1,
            merchantId: 1,
          } as never),
        ).toBe(true);
      }

      // `super_admin` is exempt from every `deny()` by `isDenied()`'s own hard-coded rule — this
      // was already true before the fix (the header comment on `provisionTenantAdmin` documents
      // it) and is unrelated to this task, asserted here only so this test cannot pass by accident
      // if that exemption were ever removed without anyone noticing it here.
      expect(
        isDenied(PortalUserCredential, {
          role: 'super_admin',
          countryId: null,
          tenantId: null,
          merchantId: null,
        } as never),
      ).toBe(false);
    });
  });

  // --- createAdmin -----------------------------------------------------------------------------

  describe('createAdmin — negative authorisation', () => {
    it('denies a non-country_admin before the tenant lookup', async () => {
      await expect(
        service.createAdmin(actor({ role: 'tenant_admin', tenantId: 1 }), 1, newAdminDto()),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('createAdmin', () => {
    it('404s for a tenant id that does not exist or is out of scope (TC-26 analogue)', async () => {
      scoped.setByPk(Tenant, null);
      await expect(service.createAdmin(actor(), 999, newAdminDto())).rejects.toBeInstanceOf(
        ScopeViolationError,
      );
    });

    it('onboards the admin against the found tenant', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 5 }));
      const result = await service.createAdmin(
        actor(),
        5,
        newAdminDto({ email: 'x@example.invalid' }),
      );
      expect(result).toMatchObject({
        email: 'x@example.invalid',
        role: 'tenant_admin',
        tenantId: 5,
      });
    });
  });

  // --- activate --------------------------------------------------------------------------------

  describe('activate — negative authorisation', () => {
    it('denies a non-country_admin before the tenant lookup', async () => {
      await expect(
        service.activate(actor({ role: 'super_admin', countryId: null }), 1),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('activate', () => {
    it('404s for a tenant id out of scope or absent', async () => {
      scoped.setByPk(Tenant, null);
      await expect(service.activate(actor(), 999)).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it('pending_provisioning → active, audit written (TC-15)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, status: 'pending_provisioning' }));
      const updated = await service.activate(actor(), 1);
      expect(updated.status).toBe('active');
      expect(audit.annotations[0]).toMatchObject({ targetId: 1, detail: { status: 'active' } });
    });

    it('409 TENANT_ALREADY_ACTIVE when already active (TC-16)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, status: 'active' }));
      await expect(service.activate(actor(), 1)).rejects.toBeInstanceOf(TenantAlreadyActiveError);
      expect(scoped.callsTo('update')).toHaveLength(0);
    });

    it('409 TENANT_ALREADY_ACTIVE when suspended — /activate is onboarding-only, not reactivation', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, status: 'suspended' }));
      await expect(service.activate(actor(), 1)).rejects.toBeInstanceOf(TenantAlreadyActiveError);
    });
  });

  // --- update ------------------------------------------------------------------------------------

  describe('update — negative authorisation', () => {
    it('denies a non-country_admin before the tenant lookup', async () => {
      await expect(
        service.update(
          actor({ role: 'tenant_admin', tenantId: 1 }),
          1,
          { name: 'x' } as UpdateTenantDto,
          requestContext(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('404s for an id out of scope or absent (TC-5)', async () => {
      scoped.setByPk(Tenant, null);
      await expect(
        service.update(actor(), 999, { name: 'x' } as UpdateTenantDto, requestContext()),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it('writes only the fields supplied, never code/countryId', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      await service.update(actor(), 1, { name: 'New Name' } as UpdateTenantDto, requestContext());

      const call = scoped.callsTo('update')[0];
      expect(call.values).toEqual({ name: 'New Name' });
    });

    it('writes contactEmail and contactPhone individually when supplied', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      await service.update(
        actor(),
        1,
        { contactEmail: 'ops@acme.example' } as UpdateTenantDto,
        requestContext(),
      );
      expect(scoped.callsTo('update')[0].values).toEqual({ contactEmail: 'ops@acme.example' });

      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      await service.update(
        actor(),
        1,
        { contactPhone: '+60123456789' } as UpdateTenantDto,
        requestContext(),
      );
      expect(scoped.callsTo('update')[1].values).toEqual({ contactPhone: '+60123456789' });
    });

    it('is a no-op write for an empty body, and never revokes sessions', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      await service.update(actor(), 1, {} as UpdateTenantDto, requestContext());
      expect(scoped.callsTo('update')).toHaveLength(0);
      expect(sessions.revocations).toHaveLength(0);
    });

    it('the returned row reflects the write (fake update() mutates the fixture in place)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, name: 'Old' }));
      const updated = await service.update(
        actor(),
        1,
        { name: 'New' } as UpdateTenantDto,
        requestContext(),
      );
      expect(updated.name).toBe('New');
    });

    it('audits the updated fields', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      await service.update(actor(), 1, { name: 'New' } as UpdateTenantDto, requestContext());
      expect(audit.annotations[0]).toMatchObject({ targetId: 1, detail: { fields: ['name'] } });
    });

    it('maps a duplicate code conflict on update to 409 TENANT_CODE_EXISTS', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      scoped.failNextUpdate(Tenant, new UniqueConstraintError({ fields: { code: 'X' } } as never));

      await expect(
        service.update(actor(), 1, { name: 'New' } as UpdateTenantDto, requestContext()),
      ).rejects.toBeInstanceOf(TenantCodeExistsError);
    });

    it('maps a duplicate schema_prefix conflict on update to 409 TENANT_SCHEMA_PREFIX_EXISTS', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      scoped.failNextUpdate(
        Tenant,
        new UniqueConstraintError({ fields: { schema_prefix: 'x' } } as never),
      );

      await expect(
        service.update(actor(), 1, { schemaPrefix: 'newpfx' } as UpdateTenantDto, requestContext()),
      ).rejects.toBeInstanceOf(TenantSchemaPrefixExistsError);
    });

    it('propagates a non-unique-constraint failure from the update unchanged', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      scoped.failNextUpdate(Tenant, new Error('unexpected database failure'));

      await expect(
        service.update(actor(), 1, { name: 'New' } as UpdateTenantDto, requestContext()),
      ).rejects.toThrow('unexpected database failure');
    });

    // --- implementation note 8 / TC-18 — session revocation on suspension --------------------

    it('suspending an active tenant revokes every session for every user in that tenant (TC-18)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, status: 'active' }));
      scoped.setListRows(PortalUser, [
        portalUserRow({ id: 501 }),
        portalUserRow({ id: 502 }),
        portalUserRow({ id: 503 }),
      ]);

      const who = actor({ userId: 9 });
      const ctx = requestContext({ ipAddress: '198.51.100.9' });
      await service.update(who, 1, { status: 'suspended' } as UpdateTenantDto, ctx);

      expect(sessions.revocations).toHaveLength(3);
      expect(sessions.revocations.map((r) => r.userId).sort()).toEqual([501, 502, 503]);
      for (const revocation of sessions.revocations) {
        expect(revocation.reason).toBe('tenant_suspended');
        expect(revocation.exceptSessionId).toBeNull();
        expect(revocation.actor).toEqual({ userId: 9, role: 'country_admin' });
        expect(revocation.context).toBe(ctx);
        expect(revocation.eventType).toBe('tenant_suspended');
      }

      // The user lookup itself is scoped by tenantId, never fetched-then-filtered.
      const usersCall = scoped.callsTo('listAll').find((c) => c.model === PortalUser.name);
      expect(usersCall?.options).toMatchObject({ where: { tenantId: 1 } });
    });

    it('setting status to inactive also revokes sessions — any non-active transition qualifies', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, status: 'active' }));
      scoped.setListRows(PortalUser, [portalUserRow({ id: 501 })]);

      await service.update(actor(), 1, { status: 'inactive' } as UpdateTenantDto, requestContext());

      expect(sessions.revocations).toHaveLength(1);
    });

    it('activating (status: active) never revokes sessions', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, status: 'pending_provisioning' }));
      scoped.setListRows(PortalUser, [portalUserRow({ id: 501 })]);

      await service.update(actor(), 1, { status: 'active' } as UpdateTenantDto, requestContext());

      expect(sessions.revocations).toHaveLength(0);
    });

    it('setting status to the same value it already had does not revoke sessions', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, status: 'suspended' }));
      scoped.setListRows(PortalUser, [portalUserRow({ id: 501 })]);

      await service.update(
        actor(),
        1,
        { status: 'suspended' } as UpdateTenantDto,
        requestContext(),
      );

      expect(sessions.revocations).toHaveLength(0);
    });

    it('a tenant with zero users triggers zero revocation calls, not an error', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, status: 'active' }));
      scoped.setListRows(PortalUser, []);

      await expect(
        service.update(actor(), 1, { status: 'suspended' } as UpdateTenantDto, requestContext()),
      ).resolves.toBeDefined();

      expect(sessions.revocations).toHaveLength(0);
    });

    it('other fields changing alongside a non-status update never revoke sessions', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1, status: 'active' }));
      scoped.setListRows(PortalUser, [portalUserRow({ id: 501 })]);

      await service.update(actor(), 1, { name: 'Renamed' } as UpdateTenantDto, requestContext());

      expect(sessions.revocations).toHaveLength(0);
    });
  });

  // --- budget ceilings -----------------------------------------------------------------------

  describe('listBudgetCeilings', () => {
    it('404s before touching tenant_budget_ceilings when the tenant itself is out of scope (TC-26)', async () => {
      scoped.setByPk(Tenant, null);
      await expect(service.listBudgetCeilings(999)).rejects.toBeInstanceOf(ScopeViolationError);
      expect(scoped.callsTo('listAll').some((c) => c.model === TenantBudgetCeiling.name)).toBe(
        false,
      );
    });

    it('returns the tenant’s ceilings, sorted by unit (TC-22 coexistence)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      scoped.setListRows(TenantBudgetCeiling, [
        budgetCeilingRow({ id: 1, tenantId: 1, unitType: 'currency', unitCode: 'MYR' }),
        budgetCeilingRow({ id: 2, tenantId: 1, unitType: 'points', unitCode: 'PTS' }),
      ]);

      const rows = await service.listBudgetCeilings(1);
      expect(rows).toHaveLength(2);
    });
  });

  describe('listTenantsWithoutCeiling (implementation note 7, TC-28)', () => {
    it('returns an empty list without querying ceilings when there are no tenants in scope', async () => {
      scoped.setListRows(Tenant, []);
      const rows = await service.listTenantsWithoutCeiling();
      expect(rows).toEqual([]);
      expect(scoped.callsTo('listAll').some((c) => c.model === TenantBudgetCeiling.name)).toBe(
        false,
      );
    });

    it('lists tenants with zero tenant_budget_ceilings rows, excluding tenants that have one', async () => {
      scoped.setListRows(Tenant, [
        tenantRow({ id: 1, name: 'Has ceiling' }),
        tenantRow({ id: 2, name: 'No ceiling' }),
      ]);
      scoped.setListRows(TenantBudgetCeiling, [budgetCeilingRow({ tenantId: 1 })]);

      const rows = await service.listTenantsWithoutCeiling();
      expect(rows).toEqual([{ id: 2, code: 'T001', countryId: 1, name: 'No ceiling' }]);
    });
  });

  describe('upsertBudgetCeiling — negative authorisation (TC-24)', () => {
    it('denies a non-country_admin before the tenant lookup', async () => {
      await expect(
        service.upsertBudgetCeiling(
          actor({ role: 'tenant_admin', tenantId: 1 }),
          1,
          newCeilingDto(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('upsertBudgetCeiling', () => {
    it('404s for a tenant id out of scope or absent (TC-26)', async () => {
      scoped.setByPk(Tenant, null);
      await expect(
        service.upsertBudgetCeiling(actor(), 999, newCeilingDto()),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it('creates a new row when none exists for the unit yet (TC-21)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      scoped.setListRows(TenantBudgetCeiling, []);

      const rows = await service.upsertBudgetCeiling(
        actor({ userId: 3 }),
        1,
        newCeilingDto({ warnAboveAmount: '4000000' }),
      );

      const createCall = scoped.callsTo('create').find((c) => c.model === TenantBudgetCeiling.name);
      expect(createCall?.values).toMatchObject({
        tenantId: 1,
        unitType: 'currency',
        unitCode: 'MYR',
        maxCampaignBudget: '5000000',
        warnAboveAmount: '4000000',
        createdBy: 3,
      });
      expect(scoped.callsTo('update').some((c) => c.model === TenantBudgetCeiling.name)).toBe(
        false,
      );
      expect(rows).toEqual([]); // the fake's listAll for the final read returns [] unless seeded
    });

    it('updates the existing row for the same unit rather than creating a second one (TC-29)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      const existing = budgetCeilingRow({
        id: 42,
        tenantId: 1,
        unitType: 'currency',
        unitCode: 'MYR',
      });
      scoped.setListRows(TenantBudgetCeiling, [existing]);

      await service.upsertBudgetCeiling(
        actor(),
        1,
        newCeilingDto({ maxCampaignBudget: '3000000' }),
      );

      const updateCall = scoped.callsTo('update').find((c) => c.model === TenantBudgetCeiling.name);
      expect(updateCall?.options).toMatchObject({ where: { id: 42 } });
      expect(updateCall?.values).toMatchObject({ maxCampaignBudget: '3000000' });
      expect(scoped.callsTo('create').some((c) => c.model === TenantBudgetCeiling.name)).toBe(
        false,
      );
    });

    it('a separate unit for the same tenant creates its own row (TC-22)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      scoped.setListRows(TenantBudgetCeiling, [
        budgetCeilingRow({ id: 1, tenantId: 1, unitType: 'currency', unitCode: 'MYR' }),
      ]);

      await service.upsertBudgetCeiling(
        actor(),
        1,
        newCeilingDto({ unitType: 'points', unitCode: 'PTS', maxCampaignBudget: '100000' }),
      );

      const createCall = scoped.callsTo('create').find((c) => c.model === TenantBudgetCeiling.name);
      expect(createCall?.values).toMatchObject({ unitType: 'points', unitCode: 'PTS' });
    });

    it('audits the tenant id, unitType and unitCode', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      scoped.setListRows(TenantBudgetCeiling, []);

      await service.upsertBudgetCeiling(actor(), 1, newCeilingDto());

      expect(audit.annotations[0]).toMatchObject({
        targetId: 1,
        detail: { unitType: 'currency', unitCode: 'MYR' },
      });
    });

    it('every call in the transaction shares the same transaction handle', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 1 }));
      scoped.setListRows(TenantBudgetCeiling, []);

      await service.upsertBudgetCeiling(actor(), 1, newCeilingDto());

      const relevant = [
        ...scoped.callsTo('findByPkOrFail'),
        ...scoped.callsTo('create').filter((c) => c.model === TenantBudgetCeiling.name),
      ];
      const transactions = new Set(
        relevant.map((c) => (c.options as { transaction: unknown }).transaction),
      );
      expect(transactions.size).toBe(1);
    });
  });
});
