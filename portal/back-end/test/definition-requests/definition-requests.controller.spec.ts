/**
 * T-042 — `DefinitionRequestsController`: thin, and metadata-driven. Same shape
 * `test/rules/rules.controller.spec.ts` (T-031) establishes: the 403/404 behaviour itself is
 * `PermissionsGuard`'s/`DefinitionRequestsService`'s respectively (both already exhaustively
 * tested elsewhere); this suite proves the controller declares the right
 * `role_entity_permissions` grant per route (R6) and delegates without adding logic.
 */
import 'reflect-metadata';
import { PERMISSION_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { DefinitionRequestsController } from '@/modules/definition-requests/definition-requests.controller';
import type { DefinitionRequestsService } from '@/modules/definition-requests/definition-requests.service';
import { actor } from './support/definition-requests-doubles';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function auditOf(handler: (...args: never[]) => unknown): { event: string; targetType?: string } {
  return Reflect.getMetadata(AUDIT_METADATA, handler) as { event: string; targetType?: string };
}

describe('DefinitionRequestsController — authorisation metadata (R6)', () => {
  it('reads require definition_request:view', () => {
    expect(permissionOf(DefinitionRequestsController.prototype.list)).toEqual({
      entity: 'definition_request',
      action: 'view',
    });
    expect(permissionOf(DefinitionRequestsController.prototype.findOne)).toEqual({
      entity: 'definition_request',
      action: 'view',
    });
  });

  it('create/update/withdraw require definition_request:create/update/withdraw — country_admin/tenant_admin only (T042_001 seed)', () => {
    expect(permissionOf(DefinitionRequestsController.prototype.create)).toEqual({
      entity: 'definition_request',
      action: 'create',
    });
    expect(permissionOf(DefinitionRequestsController.prototype.update)).toEqual({
      entity: 'definition_request',
      action: 'update',
    });
    expect(permissionOf(DefinitionRequestsController.prototype.withdraw)).toEqual({
      entity: 'definition_request',
      action: 'withdraw',
    });
  });

  it('review/fulfil require definition_request:review/fulfil — super_admin only (T042_001 seed)', () => {
    expect(permissionOf(DefinitionRequestsController.prototype.review)).toEqual({
      entity: 'definition_request',
      action: 'review',
    });
    expect(permissionOf(DefinitionRequestsController.prototype.fulfil)).toEqual({
      entity: 'definition_request',
      action: 'fulfil',
    });
  });

  it('every mutating route is audited (R6-adjacent — traceability)', () => {
    expect(auditOf(DefinitionRequestsController.prototype.create)).toMatchObject({
      event: 'definition_request_submitted',
    });
    expect(auditOf(DefinitionRequestsController.prototype.update)).toMatchObject({
      event: 'definition_request_updated',
    });
    expect(auditOf(DefinitionRequestsController.prototype.withdraw)).toMatchObject({
      event: 'definition_request_withdrawn',
    });
    expect(auditOf(DefinitionRequestsController.prototype.review)).toMatchObject({
      event: 'definition_request_reviewed',
    });
    expect(auditOf(DefinitionRequestsController.prototype.fulfil)).toMatchObject({
      event: 'definition_request_fulfilled',
    });
  });

  it('reads carry no @Audit — no write to record', () => {
    expect(auditOf(DefinitionRequestsController.prototype.list)).toBeUndefined();
    expect(auditOf(DefinitionRequestsController.prototype.findOne)).toBeUndefined();
  });
});

describe('DefinitionRequestsController — delegation', () => {
  function controllerWith(
    service: Partial<DefinitionRequestsService>,
  ): DefinitionRequestsController {
    return new DefinitionRequestsController(service as DefinitionRequestsService);
  }

  it('list() wraps {rows, meta} into {data, meta}', async () => {
    const list = jest.fn().mockResolvedValue({
      rows: [{ id: 1 }],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const controller = controllerWith({ list });

    const response = await controller.list({});
    expect(list).toHaveBeenCalledWith({});
    expect(response.data).toHaveLength(1);
    expect(response.meta.total).toBe(1);
  });

  it('findOne() passes the id through', async () => {
    const getById = jest.fn().mockResolvedValue({ id: 9 });
    const controller = controllerWith({ getById });

    const response = await controller.findOne(9);
    expect(getById).toHaveBeenCalledWith(9);
    expect(response.data).toMatchObject({ id: 9 });
  });

  it('create() passes the actor and dto through', async () => {
    const create = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ create });
    const who = actor();
    const dto = {
      requestType: 'new_rule',
      title: 'A new rule',
      description: 'Please build me a rule.',
    } as Parameters<DefinitionRequestsService['create']>[1];

    await controller.create(who, dto);
    expect(create).toHaveBeenCalledWith(who, dto);
  });

  it('update() passes the actor, id and dto through', async () => {
    const update = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ update });
    const who = actor();
    const dto = { title: 'Updated' };

    await controller.update(who, 1, dto);
    expect(update).toHaveBeenCalledWith(who, 1, dto);
  });

  it('withdraw() passes the actor and id through', async () => {
    const withdraw = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ withdraw });
    const who = actor();

    await controller.withdraw(who, 1);
    expect(withdraw).toHaveBeenCalledWith(who, 1);
  });

  it('review() passes the actor, id and dto through', async () => {
    const review = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ review });
    const who = actor();
    const dto = { status: 'under_review' as const };

    await controller.review(who, 1, dto);
    expect(review).toHaveBeenCalledWith(who, 1, dto);
  });

  it('fulfil() passes the actor, id and dto through', async () => {
    const fulfil = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ fulfil });
    const who = actor();
    const dto = { versionId: 10 };

    await controller.fulfil(who, 1, dto);
    expect(fulfil).toHaveBeenCalledWith(who, 1, dto);
  });
});
