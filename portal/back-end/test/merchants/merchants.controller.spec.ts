/**
 * T-036 — `MerchantsController`: thin, and metadata-driven. Same shape
 * `tenants.controller.spec.ts` establishes: 403/404 behaviour is `RolesGuard`'s/
 * `PermissionsGuard`'s and `MerchantsService`'s respectively (both already exhaustively tested
 * elsewhere); this suite proves the controller declares the right `role_entity_permissions`
 * grant per route (R6) and delegates without adding logic of its own.
 */
import 'reflect-metadata';
import type { Request } from 'express';
import { PERMISSION_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { MerchantsController } from '@/modules/merchants/merchants.controller';
import type { MerchantsService } from '@/modules/merchants/merchants.service';
import {
  actor,
  merchantRow,
  merchantStoreRow,
  merchantActivityRow,
} from './support/merchants-doubles';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return { ip: '203.0.113.5', headers: { 'user-agent': 'jest-agent' }, ...overrides } as Request;
}

describe('MerchantsController — authorisation metadata (R6)', () => {
  it('GET routes require merchant:view', () => {
    for (const handler of [
      MerchantsController.prototype.list,
      MerchantsController.prototype.findOne,
      MerchantsController.prototype.activeCampaigns,
      MerchantsController.prototype.listStores,
      MerchantsController.prototype.listActivities,
    ]) {
      expect(permissionOf(handler)).toEqual({ entity: 'merchant', action: 'view' });
    }
  });

  it('POST / and POST /:id/stores and /:id/activities require merchant:create — only tenant_admin holds it (T004_001 seed, TC-6/TC-7)', () => {
    for (const handler of [
      MerchantsController.prototype.create,
      MerchantsController.prototype.createStore,
      MerchantsController.prototype.createActivity,
    ]) {
      expect(permissionOf(handler)).toEqual({ entity: 'merchant', action: 'create' });
    }
  });

  it('PATCH /:id requires merchant:update', () => {
    expect(permissionOf(MerchantsController.prototype.update)).toEqual({
      entity: 'merchant',
      action: 'update',
    });
  });

  it('audits merchant_created, merchant_updated, merchant_store_created and merchant_activity_linked', () => {
    const events: Record<string, { event: string; targetType?: string }> = {
      create: Reflect.getMetadata(AUDIT_METADATA, MerchantsController.prototype.create),
      update: Reflect.getMetadata(AUDIT_METADATA, MerchantsController.prototype.update),
      createStore: Reflect.getMetadata(AUDIT_METADATA, MerchantsController.prototype.createStore),
      createActivity: Reflect.getMetadata(
        AUDIT_METADATA,
        MerchantsController.prototype.createActivity,
      ),
    };

    expect(events.create).toMatchObject({ event: 'merchant_created', targetType: 'merchant' });
    expect(events.update).toMatchObject({ event: 'merchant_updated', targetType: 'merchant' });
    expect(events.createStore).toMatchObject({
      event: 'merchant_store_created',
      targetType: 'merchant',
    });
    expect(events.createActivity).toMatchObject({
      event: 'merchant_activity_linked',
      targetType: 'merchant',
    });
  });
});

describe('MerchantsController — delegation', () => {
  function controllerWith(service: Partial<MerchantsService>): MerchantsController {
    return new MerchantsController(service as MerchantsService);
  }

  it('list() wraps the service result in {data, meta}', async () => {
    const list = jest.fn().mockResolvedValue({
      rows: [merchantRow()],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const controller = controllerWith({ list });

    const response = await controller.list({});

    expect(list).toHaveBeenCalledWith({});
    expect(response.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(response.data).toHaveLength(1);
  });

  it('findOne() delegates the numeric id and wraps in {data}', async () => {
    const getById = jest.fn().mockResolvedValue(merchantRow({ id: 9 }));
    const controller = controllerWith({ getById });

    const response = await controller.findOne(9);

    expect(getById).toHaveBeenCalledWith(9);
    expect(response.data).toMatchObject({ id: 9 });
  });

  it('activeCampaigns() delegates the numeric id', async () => {
    const listActiveCampaigns = jest.fn().mockResolvedValue([]);
    const controller = controllerWith({ listActiveCampaigns });

    const response = await controller.activeCampaigns(7);

    expect(listActiveCampaigns).toHaveBeenCalledWith(7);
    expect(response.data).toEqual([]);
  });

  it('listStores() delegates the numeric id', async () => {
    const listStores = jest.fn().mockResolvedValue([merchantStoreRow()]);
    const controller = controllerWith({ listStores });

    const response = await controller.listStores(1);

    expect(listStores).toHaveBeenCalledWith(1);
    expect(response.data).toHaveLength(1);
  });

  it('listActivities() delegates the numeric id', async () => {
    const listActivities = jest.fn().mockResolvedValue([merchantActivityRow()]);
    const controller = controllerWith({ listActivities });

    const response = await controller.listActivities(1);

    expect(listActivities).toHaveBeenCalledWith(1);
    expect(response.data).toHaveLength(1);
  });

  it('create() passes the actor and the dto through, untouched', async () => {
    const create = jest.fn().mockResolvedValue(merchantRow());
    const controller = controllerWith({ create });
    const who = actor();
    const dto = { merchantCode: 'M001' } as Parameters<MerchantsService['create']>[1];

    await controller.create(who, dto);

    expect(create).toHaveBeenCalledWith(who, dto);
  });

  it('update() passes the actor, id, dto and a request-derived context through', async () => {
    const update = jest.fn().mockResolvedValue(merchantRow({ id: 1 }));
    const controller = controllerWith({ update });
    const who = actor();
    const dto = { name: 'New' } as Parameters<MerchantsService['update']>[2];

    await controller.update(who, 1, dto, fakeRequest());

    expect(update).toHaveBeenCalledWith(who, 1, dto, {
      ipAddress: '203.0.113.5',
      userAgent: 'jest-agent',
    });
  });

  it('update() falls back to null ip/user-agent when the request carries neither', async () => {
    const update = jest.fn().mockResolvedValue(merchantRow({ id: 1 }));
    const controller = controllerWith({ update });
    const who = actor();
    const dto = { name: 'New' } as Parameters<MerchantsService['update']>[2];

    await controller.update(who, 1, dto, fakeRequest({ ip: undefined, headers: {} }));

    expect(update).toHaveBeenCalledWith(who, 1, dto, { ipAddress: null, userAgent: null });
  });

  it('createStore() passes the actor, id and dto through', async () => {
    const createStore = jest.fn().mockResolvedValue(merchantStoreRow());
    const controller = controllerWith({ createStore });
    const who = actor();
    const dto = { storeCode: 'S001' } as Parameters<MerchantsService['createStore']>[2];

    await controller.createStore(who, 1, dto);

    expect(createStore).toHaveBeenCalledWith(who, 1, dto);
  });

  it('createActivity() passes the actor, id and dto through', async () => {
    const createActivity = jest.fn().mockResolvedValue(merchantActivityRow());
    const controller = controllerWith({ createActivity });
    const who = actor();
    const dto = { activityId: 50 } as Parameters<MerchantsService['createActivity']>[2];

    await controller.createActivity(who, 1, dto);

    expect(createActivity).toHaveBeenCalledWith(who, 1, dto);
  });
});
