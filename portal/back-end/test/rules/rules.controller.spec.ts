/**
 * T-031 — `RulesController`: thin, and metadata-driven. Same shape
 * `test/countries/countries.controller.spec.ts` (T-030) establishes: the 403/404 behaviour
 * itself is `RolesGuard`'s/`PermissionsGuard`'s and `RulesService`'s respectively (both
 * already exhaustively tested); this suite proves the controller declares the right
 * `role_entity_permissions` grant per route (R6) and delegates without adding logic.
 */
import 'reflect-metadata';
import { PERMISSION_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { RulesController } from '@/modules/rules/rules.controller';
import type { RulesService } from '@/modules/rules/rules.service';
import { actor, ruleCountryAssignmentRow } from './support/rules-doubles';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function auditOf(handler: (...args: never[]) => unknown): { event: string; targetType?: string } {
  return Reflect.getMetadata(AUDIT_METADATA, handler) as { event: string; targetType?: string };
}

describe('RulesController — authorisation metadata (R6)', () => {
  it('reads require rule:view', () => {
    for (const handler of [
      RulesController.prototype.list,
      RulesController.prototype.findOne,
      RulesController.prototype.parameters,
    ]) {
      expect(permissionOf(handler)).toEqual({ entity: 'rule', action: 'view' });
    }
  });

  it('create/update/delete require rule:create/update/delete — super_admin only (T004_001 seed)', () => {
    expect(permissionOf(RulesController.prototype.create)).toEqual({
      entity: 'rule',
      action: 'create',
    });
    expect(permissionOf(RulesController.prototype.update)).toEqual({
      entity: 'rule',
      action: 'update',
    });
    expect(permissionOf(RulesController.prototype.remove)).toEqual({
      entity: 'rule',
      action: 'delete',
    });
  });

  it('assignment routes require rule_assignment:view/create/delete', () => {
    expect(permissionOf(RulesController.prototype.listCountries)).toEqual({
      entity: 'rule_assignment',
      action: 'view',
    });
    expect(permissionOf(RulesController.prototype.assignCountry)).toEqual({
      entity: 'rule_assignment',
      action: 'create',
    });
    expect(permissionOf(RulesController.prototype.unassignCountry)).toEqual({
      entity: 'rule_assignment',
      action: 'delete',
    });
  });

  it('audits every mutating route', () => {
    expect(auditOf(RulesController.prototype.create)).toMatchObject({
      event: 'rule_created',
      targetType: 'rule',
    });
    expect(auditOf(RulesController.prototype.update)).toMatchObject({
      event: 'rule_updated',
      targetType: 'rule',
    });
    expect(auditOf(RulesController.prototype.remove)).toMatchObject({
      event: 'rule_deleted',
      targetType: 'rule',
    });
    expect(auditOf(RulesController.prototype.assignCountry)).toMatchObject({
      event: 'rule_assigned',
      targetType: 'rule_assignment',
    });
    expect(auditOf(RulesController.prototype.unassignCountry)).toMatchObject({
      event: 'rule_unassigned',
      targetType: 'rule_assignment',
    });
  });
});

describe('RulesController — delegation', () => {
  function controllerWith(service: Partial<RulesService>): RulesController {
    return new RulesController(service as RulesService);
  }

  it('list() wraps the service result in {data, meta}', async () => {
    const list = jest.fn().mockResolvedValue({
      rows: [{ id: 1, ruleCode: 'X' }],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const controller = controllerWith({ list: list as unknown as RulesService['list'] });

    const response = await controller.list({});

    expect(list).toHaveBeenCalledWith({});
    expect(response.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(response.data).toHaveLength(1);
  });

  it('findOne() delegates the numeric id', async () => {
    const getById = jest.fn().mockResolvedValue({ id: 9 });
    const controller = controllerWith({ getById });

    const response = await controller.findOne(9);

    expect(getById).toHaveBeenCalledWith(9);
    expect(response.data).toMatchObject({ id: 9 });
  });

  it('parameters() delegates the numeric id', async () => {
    const getParameters = jest.fn().mockResolvedValue({ fields: [] });
    const controller = controllerWith({ getParameters });

    const response = await controller.parameters(9);

    expect(getParameters).toHaveBeenCalledWith(9);
    expect(response.data).toEqual({ fields: [] });
  });

  it('create() passes the actor and dto through, untouched', async () => {
    const create = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ create });
    const who = actor();
    const dto = { ruleCode: 'X' } as Parameters<RulesService['create']>[1];

    await controller.create(who, dto);

    expect(create).toHaveBeenCalledWith(who, dto);
  });

  it('update() passes the actor, id and dto through', async () => {
    const update = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ update });
    const who = actor();
    const dto = { name: 'New' } as Parameters<RulesService['update']>[2];

    await controller.update(who, 1, dto);

    expect(update).toHaveBeenCalledWith(who, 1, dto);
  });

  it('remove() passes the actor and id through and returns nothing (204)', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith({ remove });
    const who = actor();

    await controller.remove(who, 1);

    expect(remove).toHaveBeenCalledWith(who, 1);
  });

  it('listCountries() delegates the numeric id', async () => {
    const listCountryAssignments = jest.fn().mockResolvedValue([ruleCountryAssignmentRow()]);
    const controller = controllerWith({ listCountryAssignments });

    const response = await controller.listCountries(1);

    expect(listCountryAssignments).toHaveBeenCalledWith(1);
    expect(response.data).toHaveLength(1);
  });

  it('assignCountry() passes the actor, id and dto through', async () => {
    const assignToCountry = jest.fn().mockResolvedValue(ruleCountryAssignmentRow());
    const controller = controllerWith({ assignToCountry });
    const who = actor();
    const dto = { countryId: 2 };

    await controller.assignCountry(who, 1, dto);

    expect(assignToCountry).toHaveBeenCalledWith(who, 1, dto);
  });

  it('unassignCountry() passes the actor, ruleId and countryId through', async () => {
    const unassignFromCountry = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith({ unassignFromCountry });
    const who = actor();

    await controller.unassignCountry(who, 1, 2);

    expect(unassignFromCountry).toHaveBeenCalledWith(who, 1, 2);
  });
});
