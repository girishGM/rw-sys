/**
 * T-034 — `TenantsController`: thin, and metadata-driven. Same shape
 * `countries.controller.spec.ts` establishes: 403/404 behaviour is `RolesGuard`'s/
 * `PermissionsGuard`'s and `TenantsService`'s respectively (both already exhaustively tested
 * elsewhere); this suite proves the controller declares the right `role_entity_permissions`
 * grant per route (R6) and delegates without adding logic of its own.
 */
import 'reflect-metadata';
import type { Request } from 'express';
import { PERMISSION_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { TenantsController } from '@/modules/tenants/tenants.controller';
import type { TenantsService } from '@/modules/tenants/tenants.service';
import { actor, budgetCeilingRow, tenantRow } from './support/tenants-doubles';

function permissionOf(handler: (...args: never[]) => unknown): {
  entity: string;
  action: string;
} {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return { ip: '203.0.113.5', headers: { 'user-agent': 'jest-agent' }, ...overrides } as Request;
}

describe('TenantsController — authorisation metadata (R6)', () => {
  it('GET routes require tenant:view', () => {
    expect(permissionOf(TenantsController.prototype.list)).toEqual({
      entity: 'tenant',
      action: 'view',
    });
    expect(permissionOf(TenantsController.prototype.findOne)).toEqual({
      entity: 'tenant',
      action: 'view',
    });
    expect(permissionOf(TenantsController.prototype.listWithoutBudgetCeiling)).toEqual({
      entity: 'tenant',
      action: 'view',
    });
  });

  it('POST / requires tenant:create — only country_admin holds it (T004_001 seed, TC-6/TC-9)', () => {
    expect(permissionOf(TenantsController.prototype.create)).toEqual({
      entity: 'tenant',
      action: 'create',
    });
  });

  it('POST /:id/admins, POST /:id/activate and PATCH /:id require tenant:update', () => {
    expect(permissionOf(TenantsController.prototype.createAdmin)).toEqual({
      entity: 'tenant',
      action: 'update',
    });
    expect(permissionOf(TenantsController.prototype.activate)).toEqual({
      entity: 'tenant',
      action: 'update',
    });
    expect(permissionOf(TenantsController.prototype.update)).toEqual({
      entity: 'tenant',
      action: 'update',
    });
  });

  it('GET /:id/budget-ceilings requires tenant_budget_ceiling:view (TC-23/TC-25)', () => {
    expect(permissionOf(TenantsController.prototype.getBudgetCeilings)).toEqual({
      entity: 'tenant_budget_ceiling',
      action: 'view',
    });
  });

  it('PUT /:id/budget-ceilings requires tenant_budget_ceiling:update — only country_admin holds it (TC-24)', () => {
    expect(permissionOf(TenantsController.prototype.putBudgetCeilings)).toEqual({
      entity: 'tenant_budget_ceiling',
      action: 'update',
    });
  });

  it('audits tenant_created, tenant_admin_created, tenant_activated, tenant_updated and tenant_budget_ceiling_updated', () => {
    const events: Record<string, { event: string; targetType?: string }> = {
      create: Reflect.getMetadata(AUDIT_METADATA, TenantsController.prototype.create),
      createAdmin: Reflect.getMetadata(AUDIT_METADATA, TenantsController.prototype.createAdmin),
      activate: Reflect.getMetadata(AUDIT_METADATA, TenantsController.prototype.activate),
      update: Reflect.getMetadata(AUDIT_METADATA, TenantsController.prototype.update),
      putBudgetCeilings: Reflect.getMetadata(
        AUDIT_METADATA,
        TenantsController.prototype.putBudgetCeilings,
      ),
    };

    expect(events.create).toMatchObject({ event: 'tenant_created', targetType: 'tenant' });
    expect(events.createAdmin).toMatchObject({
      event: 'tenant_admin_created',
      targetType: 'portal_user',
    });
    expect(events.activate).toMatchObject({ event: 'tenant_activated', targetType: 'tenant' });
    expect(events.update).toMatchObject({ event: 'tenant_updated', targetType: 'tenant' });
    expect(events.putBudgetCeilings).toMatchObject({
      event: 'tenant_budget_ceiling_updated',
      targetType: 'tenant',
    });
  });
});

describe('TenantsController — delegation', () => {
  function controllerWith(service: Partial<TenantsService>): TenantsController {
    return new TenantsController(service as TenantsService);
  }

  it('list() wraps the service result in {data, meta}', async () => {
    const list = jest.fn().mockResolvedValue({
      rows: [tenantRow()],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const controller = controllerWith({ list });

    const response = await controller.list({});

    expect(list).toHaveBeenCalledWith({});
    expect(response.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(response.data).toHaveLength(1);
  });

  it('findOne() delegates the numeric id and wraps in {data}', async () => {
    const getById = jest.fn().mockResolvedValue(tenantRow({ id: 9 }));
    const controller = controllerWith({ getById });

    const response = await controller.findOne(9);

    expect(getById).toHaveBeenCalledWith(9);
    expect(response.data).toMatchObject({ id: 9 });
  });

  it('listWithoutBudgetCeiling() delegates with no arguments', async () => {
    const listTenantsWithoutCeiling = jest.fn().mockResolvedValue([]);
    const controller = controllerWith({ listTenantsWithoutCeiling });

    const response = await controller.listWithoutBudgetCeiling();

    expect(listTenantsWithoutCeiling).toHaveBeenCalledWith();
    expect(response.data).toEqual([]);
  });

  it('getBudgetCeilings() delegates the numeric id', async () => {
    const listBudgetCeilings = jest.fn().mockResolvedValue([]);
    const controller = controllerWith({ listBudgetCeilings });

    await controller.getBudgetCeilings(7);

    expect(listBudgetCeilings).toHaveBeenCalledWith(7);
  });

  it('create() passes the actor and the dto through, untouched', async () => {
    const create = jest.fn().mockResolvedValue({ tenant: tenantRow(), admin: null });
    const controller = controllerWith({ create });
    const who = actor();
    const dto = { code: 'T001' } as Parameters<TenantsService['create']>[1];

    await controller.create(who, dto);

    expect(create).toHaveBeenCalledWith(who, dto);
  });

  it('createAdmin() passes the actor, id and dto through', async () => {
    const createAdmin = jest.fn().mockResolvedValue({
      id: 5,
      email: 'x@example.invalid',
      displayName: 'X',
      role: 'tenant_admin',
      tenantId: 1,
      temporaryPassword: 'x',
    });
    const controller = controllerWith({ createAdmin });
    const who = actor();
    const dto = { email: 'x@example.invalid' } as Parameters<TenantsService['createAdmin']>[2];

    await controller.createAdmin(who, 1, dto);

    expect(createAdmin).toHaveBeenCalledWith(who, 1, dto);
  });

  it('activate() passes the actor and id through', async () => {
    const activate = jest.fn().mockResolvedValue(tenantRow({ id: 1, status: 'active' }));
    const controller = controllerWith({ activate });
    const who = actor();

    await controller.activate(who, 1);

    expect(activate).toHaveBeenCalledWith(who, 1);
  });

  it('update() passes the actor, id, dto and a request-derived context through', async () => {
    const update = jest.fn().mockResolvedValue(tenantRow({ id: 1 }));
    const controller = controllerWith({ update });
    const who = actor();
    const dto = { name: 'New' } as Parameters<TenantsService['update']>[2];

    await controller.update(who, 1, dto, fakeRequest());

    expect(update).toHaveBeenCalledWith(who, 1, dto, {
      ipAddress: '203.0.113.5',
      userAgent: 'jest-agent',
    });
  });

  it('update() falls back to null ip/user-agent when the request carries neither', async () => {
    const update = jest.fn().mockResolvedValue(tenantRow({ id: 1 }));
    const controller = controllerWith({ update });
    const who = actor();
    const dto = { name: 'New' } as Parameters<TenantsService['update']>[2];

    await controller.update(who, 1, dto, fakeRequest({ ip: undefined, headers: {} }));

    expect(update).toHaveBeenCalledWith(who, 1, dto, { ipAddress: null, userAgent: null });
  });

  it('putBudgetCeilings() passes the actor, id and dto through', async () => {
    const upsertBudgetCeiling = jest.fn().mockResolvedValue([budgetCeilingRow()]);
    const controller = controllerWith({ upsertBudgetCeiling });
    const who = actor();
    const dto = {
      unitType: 'currency',
      unitCode: 'MYR',
      maxCampaignBudget: '5000000',
    } as Parameters<TenantsService['upsertBudgetCeiling']>[2];

    const response = await controller.putBudgetCeilings(who, 10, dto);

    expect(upsertBudgetCeiling).toHaveBeenCalledWith(who, 10, dto);
    expect(response.data).toHaveLength(1);
  });
});
