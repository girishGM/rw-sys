/**
 * T-126 — `TenantCurrenciesController`: thin, and metadata-driven. Same shape
 * `tenants.controller.spec.ts` establishes: 403/404 behaviour is `PermissionsGuard`'s and
 * `TenantCurrenciesService`'s respectively (both proven elsewhere); this suite proves the
 * controller declares the right `role_entity_permissions` grant per route (R6) and delegates
 * without adding logic of its own.
 */
import 'reflect-metadata';
import { PERMISSION_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { TenantCurrenciesController } from '@/modules/tenants/tenant-currencies.controller';
import type { TenantCurrenciesService } from '@/modules/tenants/tenant-currencies.service';
import { actor, tenantCurrencyRow } from './support/tenants-doubles';

function permissionOf(handler: (...args: never[]) => unknown): {
  entity: string;
  action: string;
} {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

describe('TenantCurrenciesController — authorisation metadata (R6)', () => {
  it('GET requires tenant_currency:view', () => {
    expect(permissionOf(TenantCurrenciesController.prototype.list)).toEqual({
      entity: 'tenant_currency',
      action: 'view',
    });
  });

  it('POST requires tenant_currency:create', () => {
    expect(permissionOf(TenantCurrenciesController.prototype.create)).toEqual({
      entity: 'tenant_currency',
      action: 'create',
    });
  });

  it('PATCH requires tenant_currency:update', () => {
    expect(permissionOf(TenantCurrenciesController.prototype.update)).toEqual({
      entity: 'tenant_currency',
      action: 'update',
    });
  });

  it('audits tenant_currency_created and tenant_currency_updated', () => {
    expect(
      Reflect.getMetadata(AUDIT_METADATA, TenantCurrenciesController.prototype.create),
    ).toMatchObject({ event: 'tenant_currency_created', targetType: 'tenant_currency' });
    expect(
      Reflect.getMetadata(AUDIT_METADATA, TenantCurrenciesController.prototype.update),
    ).toMatchObject({ event: 'tenant_currency_updated', targetType: 'tenant_currency' });
  });
});

describe('TenantCurrenciesController — delegation', () => {
  function controllerWith(service: Partial<TenantCurrenciesService>): TenantCurrenciesController {
    return new TenantCurrenciesController(service as TenantCurrenciesService);
  }

  it('list() delegates the numeric tenant id and wraps in {data}', async () => {
    const list = jest.fn().mockResolvedValue([tenantCurrencyRow()]);
    const controller = controllerWith({ list });

    const response = await controller.list(10);

    expect(list).toHaveBeenCalledWith(10);
    expect(response.data).toHaveLength(1);
  });

  it('create() passes the actor, tenant id and dto through', async () => {
    const create = jest.fn().mockResolvedValue(tenantCurrencyRow());
    const controller = controllerWith({ create });
    const who = actor({ role: 'super_admin', tenantId: null, countryId: null });
    const dto = { currencyCode: 'MYR' } as Parameters<TenantCurrenciesService['create']>[2];

    await controller.create(who, 10, dto);

    expect(create).toHaveBeenCalledWith(who, 10, dto);
  });

  it('update() passes the actor, tenant id, currency id and dto through', async () => {
    const update = jest.fn().mockResolvedValue(tenantCurrencyRow());
    const controller = controllerWith({ update });
    const who = actor({ role: 'super_admin', tenantId: null, countryId: null });
    const dto = { status: 'inactive' } as Parameters<TenantCurrenciesService['update']>[3];

    await controller.update(who, 10, 1, dto);

    expect(update).toHaveBeenCalledWith(who, 10, 1, dto);
  });
});
