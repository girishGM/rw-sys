/**
 * T-030 — `CountriesController`: thin, and metadata-driven.
 *
 * Same shape `trace.controller.spec.ts` (T-045) establishes: the 403/404 behaviour itself is
 * `RolesGuard`'s/`PermissionsGuard`'s and `CountriesService`'s respectively (both already
 * exhaustively tested in their own suites — T-013 at 100% branch coverage, `CountriesService`
 * above); this suite proves the controller declares the right `role_entity_permissions`
 * grant per route (R6's negative-authorisation requirement, at the wiring level) and delegates
 * without adding logic of its own.
 */
import 'reflect-metadata';
import { PERMISSION_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { CountriesController } from '@/modules/countries/countries.controller';
import type { CountriesService } from '@/modules/countries/countries.service';
import { actor, countryRow } from './support/countries-doubles';

function permissionOf(handler: (...args: never[]) => unknown): {
  entity: string;
  action: string;
} {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

describe('CountriesController — authorisation metadata (R6)', () => {
  it('GET / and GET /:id and GET /:id/summary require country:view', () => {
    expect(permissionOf(CountriesController.prototype.list)).toEqual({
      entity: 'country',
      action: 'view',
    });
    expect(permissionOf(CountriesController.prototype.findOne)).toEqual({
      entity: 'country',
      action: 'view',
    });
    expect(permissionOf(CountriesController.prototype.summary)).toEqual({
      entity: 'country',
      action: 'view',
    });
  });

  it('POST / requires country:create — only super_admin holds it (T004_001 seed)', () => {
    expect(permissionOf(CountriesController.prototype.create)).toEqual({
      entity: 'country',
      action: 'create',
    });
  });

  it('POST /:id/admins and PATCH /:id require country:update — country_admin holds only view (TC-8)', () => {
    expect(permissionOf(CountriesController.prototype.createAdmin)).toEqual({
      entity: 'country',
      action: 'update',
    });
    expect(permissionOf(CountriesController.prototype.update)).toEqual({
      entity: 'country',
      action: 'update',
    });
  });

  it('audits country_created, country_admin_created and country_updated to the portal store', () => {
    const create = Reflect.getMetadata(AUDIT_METADATA, CountriesController.prototype.create) as {
      event: string;
      targetType?: string;
      store?: string;
    };
    const createAdmin = Reflect.getMetadata(
      AUDIT_METADATA,
      CountriesController.prototype.createAdmin,
    ) as { event: string; targetType?: string };
    const update = Reflect.getMetadata(AUDIT_METADATA, CountriesController.prototype.update) as {
      event: string;
      targetType?: string;
    };

    expect(create).toMatchObject({ event: 'country_created', targetType: 'country' });
    expect(createAdmin).toMatchObject({
      event: 'country_admin_created',
      targetType: 'portal_user',
    });
    expect(update).toMatchObject({ event: 'country_updated', targetType: 'country' });
  });
});

describe('CountriesController — delegation', () => {
  function controllerWith(service: Partial<CountriesService>): CountriesController {
    return new CountriesController(service as CountriesService);
  }

  it('list() wraps the service result in {data, meta}', async () => {
    const list = jest.fn().mockResolvedValue({
      rows: [countryRow()],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const controller = controllerWith({ list });

    const response = await controller.list({});

    expect(list).toHaveBeenCalledWith({});
    expect(response.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(response.data).toHaveLength(1);
  });

  it('findOne() delegates the numeric id and wraps in {data}', async () => {
    const getById = jest.fn().mockResolvedValue(countryRow({ id: 9 }));
    const controller = controllerWith({ getById });

    const response = await controller.findOne(9);

    expect(getById).toHaveBeenCalledWith(9);
    expect(response.data).toMatchObject({ id: 9 });
  });

  it('summary() delegates the numeric id', async () => {
    const summary = jest.fn().mockResolvedValue({
      countryId: 9,
      tenantCount: 0,
      activeTenantCount: 0,
      campaignCount: 0,
      tenants: [],
    });
    const controller = controllerWith({ summary });

    const response = await controller.summary(9);

    expect(summary).toHaveBeenCalledWith(9);
    expect(response.data.countryId).toBe(9);
  });

  it('create() passes the actor and the dto through, untouched', async () => {
    const create = jest.fn().mockResolvedValue({ country: countryRow(), admin: null });
    const controller = controllerWith({ create });
    const who = actor();
    const dto = { code: 'MY' } as Parameters<CountriesService['create']>[1];

    await controller.create(who, dto);

    expect(create).toHaveBeenCalledWith(who, dto);
  });

  it('createAdmin() passes the actor, id and dto through', async () => {
    const createAdmin = jest.fn().mockResolvedValue({
      id: 5,
      email: 'x@example.invalid',
      displayName: 'X',
      role: 'country_admin',
      countryId: 1,
      temporaryPassword: 'x',
    });
    const controller = controllerWith({ createAdmin });
    const who = actor();
    const dto = { email: 'x@example.invalid' } as Parameters<CountriesService['createAdmin']>[2];

    await controller.createAdmin(who, 1, dto);

    expect(createAdmin).toHaveBeenCalledWith(who, 1, dto);
  });

  it('update() passes the actor, id and dto through', async () => {
    const update = jest.fn().mockResolvedValue(countryRow({ id: 1 }));
    const controller = controllerWith({ update });
    const who = actor();
    const dto = { name: 'New' } as Parameters<CountriesService['update']>[2];

    await controller.update(who, 1, dto);

    expect(update).toHaveBeenCalledWith(who, 1, dto);
  });
});
