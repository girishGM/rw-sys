/**
 * T-032 — `RewardsController`: thin, and metadata-driven. Same shape `test/rules/
 * rules.controller.spec.ts` establishes: the 403/404 behaviour itself is `RolesGuard`'s/
 * `PermissionsGuard`'s and `RewardsService`'s respectively (both already exhaustively tested);
 * this suite proves the controller declares the right authorisation grant per route (R6) and
 * delegates without adding logic.
 */
import 'reflect-metadata';
import { PERMISSION_METADATA_KEY, ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { RewardsController } from '@/modules/rewards/rewards.controller';
import type { RewardsService } from '@/modules/rewards/rewards.service';
import { actor, rewardCountryAssignmentRow } from './support/rewards-doubles';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function rolesOf(handler: (...args: never[]) => unknown): readonly string[] {
  return Reflect.getMetadata(ROLES_METADATA_KEY, handler) as readonly string[];
}

function auditOf(handler: (...args: never[]) => unknown): { event: string; targetType?: string } {
  return Reflect.getMetadata(AUDIT_METADATA, handler) as { event: string; targetType?: string };
}

describe('RewardsController — authorisation metadata (R6)', () => {
  it('reads require reward:view', () => {
    expect(permissionOf(RewardsController.prototype.list)).toEqual({
      entity: 'reward',
      action: 'view',
    });
    expect(permissionOf(RewardsController.prototype.findOne)).toEqual({
      entity: 'reward',
      action: 'view',
    });
  });

  it('create/update/delete require reward:create/update/delete — super_admin only (T004_001 seed)', () => {
    expect(permissionOf(RewardsController.prototype.create)).toEqual({
      entity: 'reward',
      action: 'create',
    });
    expect(permissionOf(RewardsController.prototype.update)).toEqual({
      entity: 'reward',
      action: 'update',
    });
    expect(permissionOf(RewardsController.prototype.remove)).toEqual({
      entity: 'reward',
      action: 'delete',
    });
  });

  it('assignment routes require reward_assignment:view/create/delete', () => {
    expect(permissionOf(RewardsController.prototype.listCountries)).toEqual({
      entity: 'reward_assignment',
      action: 'view',
    });
    expect(permissionOf(RewardsController.prototype.assignCountry)).toEqual({
      entity: 'reward_assignment',
      action: 'create',
    });
    expect(permissionOf(RewardsController.prototype.unassignCountry)).toEqual({
      entity: 'reward_assignment',
      action: 'delete',
    });
  });

  it('policy and cap routes carry a static @Roles(super_admin) gate, not a permission row', () => {
    for (const handler of [
      RewardsController.prototype.listPolicies,
      RewardsController.prototype.createPolicy,
      RewardsController.prototype.updatePolicy,
      RewardsController.prototype.listPolicyCaps,
      RewardsController.prototype.createPolicyCap,
      RewardsController.prototype.updatePolicyCap,
    ]) {
      expect(rolesOf(handler)).toEqual(['super_admin']);
      expect(permissionOf(handler)).toBeUndefined();
    }
  });

  it('audits every mutating route', () => {
    expect(auditOf(RewardsController.prototype.create)).toMatchObject({
      event: 'reward_created',
      targetType: 'reward',
    });
    expect(auditOf(RewardsController.prototype.update)).toMatchObject({
      event: 'reward_updated',
      targetType: 'reward',
    });
    expect(auditOf(RewardsController.prototype.remove)).toMatchObject({
      event: 'reward_deleted',
      targetType: 'reward',
    });
    expect(auditOf(RewardsController.prototype.assignCountry)).toMatchObject({
      event: 'reward_assigned',
      targetType: 'reward_assignment',
    });
    expect(auditOf(RewardsController.prototype.unassignCountry)).toMatchObject({
      event: 'reward_unassigned',
      targetType: 'reward_assignment',
    });
    expect(auditOf(RewardsController.prototype.createPolicy)).toMatchObject({
      event: 'reward_policy_created',
    });
    expect(auditOf(RewardsController.prototype.updatePolicy)).toMatchObject({
      event: 'reward_policy_updated',
    });
    expect(auditOf(RewardsController.prototype.createPolicyCap)).toMatchObject({
      event: 'reward_policy_cap_created',
    });
    expect(auditOf(RewardsController.prototype.updatePolicyCap)).toMatchObject({
      event: 'reward_policy_cap_updated',
    });
  });
});

describe('RewardsController — delegation', () => {
  function controllerWith(service: Partial<RewardsService>): RewardsController {
    return new RewardsController(service as RewardsService);
  }

  it('list() wraps the service result in {data, meta}', async () => {
    const list = jest.fn().mockResolvedValue({
      rows: [{ id: 1, systemCode: 'X' }],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const controller = controllerWith({ list: list as unknown as RewardsService['list'] });

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

  it('create() passes the actor and dto through, untouched', async () => {
    const create = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ create });
    const who = actor();
    const dto = { systemCode: 'X' } as Parameters<RewardsService['create']>[1];

    await controller.create(who, dto);

    expect(create).toHaveBeenCalledWith(who, dto);
  });

  it('update() passes the actor, id and dto through', async () => {
    const update = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ update });
    const who = actor();
    const dto = { name: 'New' } as Parameters<RewardsService['update']>[2];

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
    const listCountryAssignments = jest.fn().mockResolvedValue([rewardCountryAssignmentRow()]);
    const controller = controllerWith({ listCountryAssignments });

    const response = await controller.listCountries(1);

    expect(listCountryAssignments).toHaveBeenCalledWith(1);
    expect(response.data).toHaveLength(1);
  });

  it('assignCountry() passes the actor, id and dto through', async () => {
    const assignToCountry = jest.fn().mockResolvedValue(rewardCountryAssignmentRow());
    const controller = controllerWith({ assignToCountry });
    const who = actor();
    const dto = { countryId: 2 };

    await controller.assignCountry(who, 1, dto);

    expect(assignToCountry).toHaveBeenCalledWith(who, 1, dto);
  });

  it('unassignCountry() passes the actor, rewardId and countryId through', async () => {
    const unassignFromCountry = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith({ unassignFromCountry });
    const who = actor();

    await controller.unassignCountry(who, 1, 2);

    expect(unassignFromCountry).toHaveBeenCalledWith(who, 1, 2);
  });

  it('listPolicies()/createPolicy()/updatePolicy() delegate their arguments', async () => {
    const listPolicies = jest.fn().mockResolvedValue([{ id: 10 }]);
    const createPolicy = jest.fn().mockResolvedValue({ id: 10 });
    const updatePolicy = jest.fn().mockResolvedValue({ id: 10 });
    const controller = controllerWith({ listPolicies, createPolicy, updatePolicy });
    const who = actor();

    await controller.listPolicies(1);
    await controller.createPolicy(who, 1, { policyCode: 'X' } as never);
    await controller.updatePolicy(who, 1, 10, { name: 'y' } as never);

    expect(listPolicies).toHaveBeenCalledWith(1);
    expect(createPolicy).toHaveBeenCalledWith(who, 1, { policyCode: 'X' });
    expect(updatePolicy).toHaveBeenCalledWith(who, 1, 10, { name: 'y' });
  });

  it('listPolicyCaps()/createPolicyCap()/updatePolicyCap() delegate their arguments', async () => {
    const listPolicyCaps = jest.fn().mockResolvedValue([{ id: 5 }]);
    const createPolicyCap = jest.fn().mockResolvedValue({ id: 5 });
    const updatePolicyCap = jest.fn().mockResolvedValue({ id: 5 });
    const controller = controllerWith({ listPolicyCaps, createPolicyCap, updatePolicyCap });
    const who = actor();

    await controller.listPolicyCaps(1, 10);
    await controller.createPolicyCap(who, 1, 10, { capType: 'per_customer' } as never);
    await controller.updatePolicyCap(who, 1, 10, 5, { status: 'inactive' } as never);

    expect(listPolicyCaps).toHaveBeenCalledWith(1, 10);
    expect(createPolicyCap).toHaveBeenCalledWith(who, 1, 10, { capType: 'per_customer' });
    expect(updatePolicyCap).toHaveBeenCalledWith(who, 1, 10, 5, { status: 'inactive' });
  });
});
