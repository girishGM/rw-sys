/**
 * T-126 — `TenantCurrenciesService`. Same property under test as `tenants.service.spec.ts`'s own
 * header states for `/tenants`: *which decision was made, and on what basis* — the real rows are
 * `ScopedRepository`'s/`scope-strategy.ts`'s to prove (T-013, 100% branch coverage there
 * already). Negative-authorisation (R6) is proven directly here, at the service layer — the
 * third of this module's own three independent layers — not only inferred from controller
 * metadata.
 */
import { UniqueConstraintError } from 'sequelize';
import { Tenant } from '@/database/models';
import { TenantCurrency } from '@/database/models/tenant-currency.model';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { TenantCurrenciesService } from '@/modules/tenants/tenant-currencies.service';
import {
  TenantCurrencyDefaultExistsError,
  TenantCurrencyExistsError,
} from '@/modules/tenants/tenants.errors';
import type { CreateTenantCurrencyDto } from '@/modules/tenants/dto/create-tenant-currency.dto';
import type { UpdateTenantCurrencyDto } from '@/modules/tenants/dto/update-tenant-currency.dto';
import {
  FakeAuditService,
  FakeScopedRepository,
  actor,
  asAuditService,
  asScopedRepository,
  tenantCurrencyRow,
  tenantRow,
} from './support/tenants-doubles';

function newCreateDto(overrides: Partial<CreateTenantCurrencyDto> = {}): CreateTenantCurrencyDto {
  return { currencyCode: 'MYR', ...overrides } as CreateTenantCurrencyDto;
}

function newUpdateDto(overrides: Partial<UpdateTenantCurrencyDto> = {}): UpdateTenantCurrencyDto {
  return { ...overrides } as UpdateTenantCurrencyDto;
}

describe('TenantCurrenciesService', () => {
  let scoped: FakeScopedRepository;
  let audit: FakeAuditService;
  let service: TenantCurrenciesService;

  beforeEach(() => {
    scoped = new FakeScopedRepository();
    audit = new FakeAuditService();
    service = new TenantCurrenciesService(asScopedRepository(scoped), asAuditService(audit));
  });

  describe('list (TC-4, TC-5)', () => {
    it('TC-4: returns the tenant’s currencies, once the tenant itself resolves in scope', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));
      scoped.setListRows(TenantCurrency, [
        tenantCurrencyRow({ id: 1, currencyCode: 'MYR', isDefault: true }),
        tenantCurrencyRow({ id: 2, currencyCode: 'SGD', isDefault: false }),
      ]);

      const result = await service.list(10);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 1, currencyCode: 'MYR', isDefault: true });
      expect(scoped.callsTo('listAll')[0].options).toMatchObject({ where: { tenantId: 10 } });
    });

    it('TC-5: a tenant outside the caller’s scope 404s before any currency row is read', async () => {
      scoped.setByPk(Tenant, null);

      await expect(service.list(999)).rejects.toBeInstanceOf(ScopeViolationError);
      expect(scoped.callsTo('listAll')).toHaveLength(0);
    });
  });

  describe('create (TC-2, TC-3, TC-6)', () => {
    it('TC-2: super_admin adds a second currency — isDefault defaults to false', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));

      const result = await service.create(
        actor({ role: 'super_admin', tenantId: null, countryId: null }),
        10,
        newCreateDto({ currencyCode: 'sgd' as unknown as string }),
      );

      const createCall = scoped.callsTo('create')[0];
      expect(createCall.values).toMatchObject({ tenantId: 10, isDefault: false, status: 'active' });
      expect(result.tenantId).toBe(10);
      expect(audit.annotations[0]).toMatchObject({ targetId: result.id, detail: { tenantId: 10 } });
    });

    it('an explicit isDefault: true is passed through untouched', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));

      await service.create(
        actor({ role: 'super_admin', tenantId: null, countryId: null }),
        10,
        newCreateDto({ isDefault: true }),
      );

      expect(scoped.callsTo('create')[0].values).toMatchObject({ isDefault: true });
    });

    it('TC-6: a non-super_admin is refused before any write is attempted', async () => {
      await expect(
        service.create(actor({ role: 'tenant_admin', tenantId: 10 }), 10, newCreateDto()),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.callsTo('create')).toHaveLength(0);
    });

    it('a tenant outside scope 404s before the insert is attempted', async () => {
      scoped.setByPk(Tenant, null);

      await expect(
        service.create(
          actor({ role: 'super_admin', tenantId: null, countryId: null }),
          999,
          newCreateDto(),
        ),
      ).rejects.toBeInstanceOf(ScopeViolationError);
      expect(scoped.callsTo('create')).toHaveLength(0);
    });

    it('TC-3: a second is_default row is mapped to TenantCurrencyDefaultExistsError (409)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));
      scoped.failNextCreate(
        TenantCurrency,
        new UniqueConstraintError({ message: 'uq_tc_one_default' }),
      );

      await expect(
        service.create(
          actor({ role: 'super_admin', tenantId: null, countryId: null }),
          10,
          newCreateDto({ isDefault: true }),
        ),
      ).rejects.toBeInstanceOf(TenantCurrencyDefaultExistsError);
    });

    it('a duplicate (tenantId, currencyCode) is mapped to TenantCurrencyExistsError (409)', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));
      scoped.failNextCreate(
        TenantCurrency,
        new UniqueConstraintError({ message: 'uq_tc_tenant_currency' }),
      );

      await expect(
        service.create(
          actor({ role: 'super_admin', tenantId: null, countryId: null }),
          10,
          newCreateDto(),
        ),
      ).rejects.toBeInstanceOf(TenantCurrencyExistsError);
    });

    it('prefers the real pg constraint name over the message when both are present', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));
      // `UniqueConstraintError` sets `this.original = options.parent` (Sequelize's own
      // constructor, `unique-constraint-error.js`) — `parent`, not `original`, is the
      // constructor option; this is the shape a real pg driver error actually arrives in.
      const error = new UniqueConstraintError({
        message: 'uq_tc_tenant_currency', // deliberately the *other* constraint's name
        parent: { name: '', message: '', sql: '', constraint: 'uq_tc_one_default' } as never,
      });
      scoped.failNextCreate(TenantCurrency, error);

      await expect(
        service.create(
          actor({ role: 'super_admin', tenantId: null, countryId: null }),
          10,
          newCreateDto({ isDefault: true }),
        ),
      ).rejects.toBeInstanceOf(TenantCurrencyDefaultExistsError);
    });

    it('a real pg constraint name that is not uq_tc_one_default maps to TenantCurrencyExistsError', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));
      const error = new UniqueConstraintError({
        message: 'irrelevant',
        parent: { name: '', message: '', sql: '', constraint: 'uq_tc_tenant_currency' } as never,
      });
      scoped.failNextCreate(TenantCurrency, error);

      await expect(
        service.create(
          actor({ role: 'super_admin', tenantId: null, countryId: null }),
          10,
          newCreateDto(),
        ),
      ).rejects.toBeInstanceOf(TenantCurrencyExistsError);
    });

    it('an unrelated error is neither mapped nor swallowed', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));
      scoped.failNextCreate(TenantCurrency, new Error('boom'));

      await expect(
        service.create(
          actor({ role: 'super_admin', tenantId: null, countryId: null }),
          10,
          newCreateDto(),
        ),
      ).rejects.toThrow('boom');
    });
  });

  describe('update', () => {
    it('updates status and returns the row read back afterwards', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));
      scoped.setByPk(TenantCurrency, tenantCurrencyRow({ id: 1, tenantId: 10, status: 'active' }));

      const result = await service.update(
        actor({ role: 'super_admin', tenantId: null, countryId: null }),
        10,
        1,
        newUpdateDto({ status: 'inactive' }),
      );

      expect(result.status).toBe('inactive');
      expect(scoped.callsTo('update')[0].options).toMatchObject({ where: { id: 1, tenantId: 10 } });
      expect(audit.annotations[0]).toMatchObject({ targetId: 1, detail: { tenantId: 10 } });
    });

    it('an empty patch performs no write', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));
      scoped.setByPk(TenantCurrency, tenantCurrencyRow({ id: 1, tenantId: 10 }));

      await service.update(
        actor({ role: 'super_admin', tenantId: null, countryId: null }),
        10,
        1,
        newUpdateDto(),
      );

      expect(scoped.callsTo('update')).toHaveLength(0);
    });

    it('a non-super_admin is refused before any lookup runs', async () => {
      await expect(
        service.update(
          actor({ role: 'tenant_admin', tenantId: 10 }),
          10,
          1,
          newUpdateDto({ status: 'inactive' }),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.callsTo('update')).toHaveLength(0);
    });

    it('a currency id that does not belong to this tenant 404s', async () => {
      scoped.setByPk(Tenant, tenantRow({ id: 10 }));
      scoped.setByPk(TenantCurrency, null);

      await expect(
        service.update(
          actor({ role: 'super_admin', tenantId: null, countryId: null }),
          10,
          999,
          newUpdateDto({ status: 'inactive' }),
        ),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });
  });
});
