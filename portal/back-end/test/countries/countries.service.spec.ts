/**
 * T-030 — `CountriesService`: country onboarding and Country Admin onboarding.
 *
 * The property under test throughout is *"which decision was made, and on what basis"* — the
 * real rows are `ScopedRepository`'s and `scope-strategy.ts`'s to prove (T-013, 100% branch
 * coverage there already). Negative-authorisation (R6, TC-8) is proven directly here at the
 * service layer — the third of 00-ARCHITECTURE.md §5.2's three independent layers this task
 * mirrors — rather than only inferred from controller metadata.
 */
import { UniqueConstraintError } from 'sequelize';
import { Country, Tenant, TenantCampaign } from '@/database/models';
import { PortalUser, PortalUserCredential } from '@/database/portal-models';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { CountriesService } from '@/modules/countries/countries.service';
import {
  AdminEmailExistsError,
  CountryCodeExistsError,
  CountryDeactivationRequiresConfirmationError,
  HqAlreadyExistsError,
} from '@/modules/countries/countries.errors';
import type { CreateCountryDto } from '@/modules/countries/dto/create-country.dto';
import type { CreateCountryAdminDto } from '@/modules/countries/dto/create-country-admin.dto';
import type { UpdateCountryDto } from '@/modules/countries/dto/update-country.dto';
import {
  FakeAuditService,
  FakeCredentialService,
  FakeScopedRepository,
  FakeSequelize,
  actor,
  asAuditService,
  asCredentialService,
  asScopedRepository,
  asSequelize,
  countryRow,
  tenantRow,
} from './support/countries-doubles';

function newCountryDto(overrides: Partial<CreateCountryDto> = {}): CreateCountryDto {
  return {
    code: 'MY',
    name: 'Malaysia',
    timezone: 'Asia/Kuala_Lumpur',
    currencyCode: 'MYR',
    dialingCode: '+60',
    ...overrides,
  } as CreateCountryDto;
}

function newAdminDto(overrides: Partial<CreateCountryAdminDto> = {}): CreateCountryAdminDto {
  return {
    email: 'admin@example.invalid',
    displayName: 'New Country Admin',
    ...overrides,
  } as CreateCountryAdminDto;
}

describe('CountriesService', () => {
  let scoped: FakeScopedRepository;
  let sequelize: FakeSequelize;
  let credentials: FakeCredentialService;
  let audit: FakeAuditService;
  let service: CountriesService;

  beforeEach(() => {
    scoped = new FakeScopedRepository();
    sequelize = new FakeSequelize();
    credentials = new FakeCredentialService();
    audit = new FakeAuditService();
    service = new CountriesService(
      asSequelize(sequelize),
      asScopedRepository(scoped),
      asCredentialService(credentials),
      asAuditService(audit),
    );
  });

  describe('list', () => {
    it('lists through ScopedRepository, so scope (Country → id = own country) applies untouched', async () => {
      scoped.setListRows(Country, [countryRow()]);
      scoped.setCount(Country, 1);

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
      await service.list({ sort: 'createdAt:desc' });
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ order: [['createdAt', 'DESC']] });
    });

    it('caps pageSize at 100 rather than rejecting a larger request (03-API-CONTRACT.md §1)', async () => {
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
      scoped.setByPk(Country, countryRow({ id: 7 }));
      const dto = await service.getById(7);
      expect(dto.id).toBe(7);
    });

    it('404s — not found or out of scope, indistinguishable (TC-10, 02-SECURITY.md §5.1)', async () => {
      scoped.setByPk(Country, null);
      const thrown: unknown = await service.getById(999).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(ScopeViolationError);
      expect((thrown as ScopeViolationError).getStatus()).toBe(404);
    });
  });

  describe('summary', () => {
    it('404s before touching tenants/campaigns when the country itself is out of scope', async () => {
      scoped.setByPk(Country, null);
      await expect(service.summary(999)).rejects.toBeInstanceOf(ScopeViolationError);
      expect(scoped.callsTo('listAll')).toHaveLength(0);
    });

    it('counts tenants, active tenants and campaigns, and lists the tenants (the deactivation-warning data)', async () => {
      scoped.setByPk(Country, countryRow({ id: 1 }));
      scoped.setListRows(Tenant, [
        tenantRow({ id: 10, status: 'active' }),
        tenantRow({ id: 11, status: 'suspended' }),
      ]);
      scoped.setCount(TenantCampaign, 4);

      const summary = await service.summary(1);

      expect(summary).toEqual({
        countryId: 1,
        tenantCount: 2,
        activeTenantCount: 1,
        campaignCount: 4,
        tenants: [
          { id: 10, code: 'T001', name: 'A Tenant', status: 'active' },
          { id: 11, code: 'T001', name: 'A Tenant', status: 'suspended' },
        ],
      });
    });

    it('short-circuits the campaign count to 0 without a query when there are no tenants', async () => {
      scoped.setByPk(Country, countryRow({ id: 1 }));
      scoped.setListRows(Tenant, []);

      const summary = await service.summary(1);

      expect(summary.campaignCount).toBe(0);
      expect(scoped.callsTo('count').some((call) => call.model === TenantCampaign.name)).toBe(
        false,
      );
    });
  });

  describe('create — negative authorisation (TC-8, AGENT-PROTOCOL R6)', () => {
    it.each(['country_admin', 'tenant_admin', 'maker', 'checker', 'merchant'] as const)(
      '%s is denied — assertRole fires before any query, transaction included',
      async (role) => {
        await expect(
          service.create(
            actor({ role, countryId: role === 'country_admin' ? 1 : null }),
            newCountryDto(),
          ),
        ).rejects.toBeInstanceOf(PermissionDeniedHttpException);

        expect(sequelize.transactionCalls).toBe(0);
        expect(scoped.calls).toHaveLength(0);
      },
    );
  });

  describe('create', () => {
    it('creates the country as super_admin, status active, isHq defaulted false', async () => {
      const result = await service.create(actor(), newCountryDto());

      expect(result.country).toMatchObject({
        code: 'MY',
        name: 'Malaysia',
        status: 'active',
        isHq: false,
      });
      expect(result.admin).toBeNull();

      const call = scoped.callsTo('create').find((c) => c.model === Country.name);
      expect(call?.values).toMatchObject({ status: 'active', isHq: false });
    });

    it('upper-cases nothing itself — the DTO already normalised code/currencyCode (implementation note 2)', async () => {
      await service.create(actor(), newCountryDto({ code: 'MY', currencyCode: 'MYR' }));
      const call = scoped.callsTo('create').find((c) => c.model === Country.name);
      expect(call?.values).toMatchObject({ code: 'MY', currencyCode: 'MYR' });
    });

    it('audits the created country id', async () => {
      await service.create(actor(), newCountryDto());
      expect(audit.annotations[0]).toMatchObject({ targetId: expect.any(Number) });
    });

    it('maps a duplicate code to 409 COUNTRY_CODE_EXISTS, never the raw constraint name (TC-2)', async () => {
      scoped.failNextCreate(
        Country,
        new UniqueConstraintError({ message: 'uq_countries_code' } as never),
      );

      await expect(service.create(actor(), newCountryDto())).rejects.toBeInstanceOf(
        CountryCodeExistsError,
      );
    });

    it('propagates any other failure from the country insert unchanged (not mapped to a business error)', async () => {
      scoped.failNextCreate(Country, new Error('unexpected database failure'));

      await expect(service.create(actor(), newCountryDto())).rejects.toThrow(
        'unexpected database failure',
      );
    });

    it('422 HQ_ALREADY_EXISTS when isHq is requested and one already exists (TC-5)', async () => {
      scoped.setCount(Country, 1);

      await expect(service.create(actor(), newCountryDto({ isHq: true }))).rejects.toBeInstanceOf(
        HqAlreadyExistsError,
      );

      // The country itself must never be written — the whole point of checking first.
      expect(scoped.callsTo('create').some((c) => c.model === Country.name)).toBe(false);
    });

    it('succeeds when isHq is requested and none exists yet', async () => {
      scoped.setCount(Country, 0);
      const result = await service.create(actor(), newCountryDto({ isHq: true }));
      expect(result.country.isHq).toBe(true);
    });

    it('creates the country and its Country Admin in one transaction (TC-6)', async () => {
      const result = await service.create(
        actor(),
        newCountryDto({ admin: newAdminDto({ email: 'ca@example.invalid', displayName: 'CA' }) }),
      );

      expect(result.admin).toMatchObject({
        email: 'ca@example.invalid',
        displayName: 'CA',
        role: 'country_admin',
        countryId: result.country.id,
      });
      expect(result.admin?.temporaryPassword).toEqual(expect.any(String));
      expect(result.admin?.temporaryPassword.length).toBeGreaterThanOrEqual(20);

      expect(scoped.callsTo('create').map((c) => c.model)).toEqual([
        Country.name,
        PortalUser.name,
        PortalUserCredential.name,
      ]);
    });

    it('the admin gets must_change_password=true, status active, and is created by the actor', async () => {
      await service.create(actor({ userId: 42 }), newCountryDto({ admin: newAdminDto() }));
      const call = scoped.callsTo('create').find((c) => c.model === PortalUser.name);
      expect(call?.values).toMatchObject({
        role: 'country_admin',
        status: 'active',
        mustChangePassword: true,
        createdBy: 42,
      });
    });

    it('every create in the transaction shares the same transaction handle (TC-7 — atomicity)', async () => {
      await service.create(actor(), newCountryDto({ admin: newAdminDto() }));
      const creates = scoped.callsTo('create');
      const transactions = new Set(
        creates.map((c) => (c.options as { transaction: unknown }).transaction),
      );
      expect(transactions.size).toBe(1);
    });

    it('maps a duplicate admin email to 409 ADMIN_EMAIL_EXISTS', async () => {
      scoped.failNextCreate(
        PortalUser,
        new UniqueConstraintError({ message: 'uq_portal_users_email_live' } as never),
      );

      await expect(
        service.create(actor(), newCountryDto({ admin: newAdminDto() })),
      ).rejects.toBeInstanceOf(AdminEmailExistsError);
    });

    it('a failure creating the admin propagates out of the one transaction (TC-7 — rollback proven at the code-structure level; Sequelize itself guarantees the rollback for the real connection)', async () => {
      scoped.failNextCreate(PortalUser, new Error('simulated failure mid-transaction'));

      await expect(
        service.create(actor(), newCountryDto({ admin: newAdminDto() })),
      ).rejects.toThrow('simulated failure mid-transaction');
    });
  });

  describe('createAdmin — negative authorisation', () => {
    it('denies a non-super_admin before the country lookup', async () => {
      await expect(
        service.createAdmin(actor({ role: 'country_admin', countryId: 1 }), 1, newAdminDto()),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('createAdmin', () => {
    it('404s for a country id that does not exist', async () => {
      scoped.setByPk(Country, null);
      await expect(service.createAdmin(actor(), 999, newAdminDto())).rejects.toBeInstanceOf(
        ScopeViolationError,
      );
    });

    it('onboards the admin against the found country', async () => {
      scoped.setByPk(Country, countryRow({ id: 5 }));
      const result = await service.createAdmin(
        actor(),
        5,
        newAdminDto({ email: 'x@example.invalid' }),
      );
      expect(result).toMatchObject({
        email: 'x@example.invalid',
        role: 'country_admin',
        countryId: 5,
      });
    });
  });

  describe('update — negative authorisation', () => {
    it('denies a non-super_admin before the country lookup', async () => {
      await expect(
        service.update(actor({ role: 'country_admin', countryId: 1 }), 1, { name: 'x' }),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('404s for an id out of scope or absent', async () => {
      scoped.setByPk(Country, null);
      await expect(service.update(actor(), 999, { name: 'x' })).rejects.toBeInstanceOf(
        ScopeViolationError,
      );
    });

    it('writes only the fields supplied, never `code`', async () => {
      scoped.setByPk(Country, countryRow({ id: 1 }));
      await service.update(actor(), 1, { name: 'New Name' } as UpdateCountryDto);

      const call = scoped.callsTo('update')[0];
      expect(call.values).toEqual({ name: 'New Name' });
    });

    it('writes every other individually-updatable field the same way (timezone, currencyCode, dialingCode)', async () => {
      scoped.setByPk(Country, countryRow({ id: 1 }));
      await service.update(actor(), 1, {
        timezone: 'Asia/Singapore',
        currencyCode: 'SGD',
        dialingCode: '+65',
      } as UpdateCountryDto);

      const call = scoped.callsTo('update')[0];
      expect(call.values).toEqual({
        timezone: 'Asia/Singapore',
        currencyCode: 'SGD',
        dialingCode: '+65',
      });
    });

    it('is a no-op write (no `update` call at all) for an empty body', async () => {
      scoped.setByPk(Country, countryRow({ id: 1 }));
      await service.update(actor(), 1, {} as UpdateCountryDto);
      expect(scoped.callsTo('update')).toHaveLength(0);
    });

    it('the returned row reflects the write (fake update() mutates the fixture in place)', async () => {
      scoped.setByPk(Country, countryRow({ id: 1, name: 'Old' }));
      const updated = await service.update(actor(), 1, { name: 'New' } as UpdateCountryDto);
      expect(updated.name).toBe('New');
    });

    it('audits the updated fields', async () => {
      scoped.setByPk(Country, countryRow({ id: 1 }));
      await service.update(actor(), 1, { name: 'New' } as UpdateCountryDto);
      expect(audit.annotations[0]).toMatchObject({ targetId: 1, detail: { fields: ['name'] } });
    });

    it('422 HQ_ALREADY_EXISTS when isHq:true collides with another country (TC-5)', async () => {
      scoped.setByPk(Country, countryRow({ id: 1, isHq: false }));
      scoped.setCount(Country, 1);

      await expect(
        service.update(actor(), 1, { isHq: true } as UpdateCountryDto),
      ).rejects.toBeInstanceOf(HqAlreadyExistsError);
      expect(scoped.callsTo('update')).toHaveLength(0);
    });

    it('does not re-check HQ availability when the country already is the HQ', async () => {
      scoped.setByPk(Country, countryRow({ id: 1, isHq: true }));
      scoped.setCount(Country, 5); // would fail the check if it ran

      await expect(
        service.update(actor(), 1, { isHq: true } as UpdateCountryDto),
      ).resolves.toBeDefined();
    });

    it('422 requires confirm:true to deactivate a country with active tenants (TC-14)', async () => {
      scoped.setByPk(Country, countryRow({ id: 1, status: 'active' }));
      scoped.setCount(Tenant, 3);

      await expect(
        service.update(actor(), 1, { status: 'inactive' } as UpdateCountryDto),
      ).rejects.toBeInstanceOf(CountryDeactivationRequiresConfirmationError);
      expect(scoped.callsTo('update')).toHaveLength(0);
    });

    it('deactivates with active tenants once confirm:true is sent', async () => {
      scoped.setByPk(Country, countryRow({ id: 1, status: 'active' }));
      scoped.setCount(Tenant, 3);

      const updated = await service.update(actor(), 1, {
        status: 'inactive',
        confirm: true,
      } as UpdateCountryDto);
      expect(updated.status).toBe('inactive');
    });

    it('deactivates without confirmation when there are no active tenants', async () => {
      scoped.setByPk(Country, countryRow({ id: 1, status: 'active' }));
      scoped.setCount(Tenant, 0);

      const updated = await service.update(actor(), 1, { status: 'inactive' } as UpdateCountryDto);
      expect(updated.status).toBe('inactive');
    });

    it('never cascades: no write ever touches the tenants table (implementation note 7)', async () => {
      scoped.setByPk(Country, countryRow({ id: 1, status: 'active' }));
      scoped.setCount(Tenant, 3);

      await service.update(actor(), 1, { status: 'inactive', confirm: true } as UpdateCountryDto);

      expect(scoped.callsTo('update').every((call) => call.model === Country.name)).toBe(true);
    });
  });
});
