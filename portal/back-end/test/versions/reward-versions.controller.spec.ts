/**
 * T-041 — `RewardVersionsController`: mirrors `rule-versions.controller.spec.ts` exactly, over
 * `REWARD_ENTITY`.
 */
import 'reflect-metadata';
import { PERMISSION_METADATA_KEY, ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { RewardVersionsController } from '@/modules/versions/reward-versions.controller';
import type { RewardVersionsService } from '@/modules/versions/reward-versions.service';
import { actor } from './support/versions-doubles';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function rolesOf(handler: (...args: never[]) => unknown): readonly string[] {
  return Reflect.getMetadata(ROLES_METADATA_KEY, handler) as readonly string[];
}

describe('RewardVersionsController — authorisation metadata (R6)', () => {
  it('reads reuse reward:view', () => {
    for (const handler of [
      RewardVersionsController.prototype.list,
      RewardVersionsController.prototype.findOne,
      RewardVersionsController.prototype.diff,
      RewardVersionsController.prototype.countries,
    ]) {
      expect(permissionOf(handler)).toEqual({ entity: 'reward', action: 'view' });
    }
  });

  it('every write route is super_admin only', () => {
    for (const handler of [
      RewardVersionsController.prototype.create,
      RewardVersionsController.prototype.update,
      RewardVersionsController.prototype.publish,
      RewardVersionsController.prototype.deprecate,
      RewardVersionsController.prototype.retire,
      RewardVersionsController.prototype.withdraw,
    ]) {
      expect(rolesOf(handler)).toEqual(['super_admin']);
    }
  });
});

describe('RewardVersionsController — delegation', () => {
  function controllerWith(service: Partial<RewardVersionsService>): RewardVersionsController {
    return new RewardVersionsController(service as RewardVersionsService);
  }

  it('create() passes the actor, rewardId and dto through', async () => {
    const createDraft = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ createDraft });
    const who = actor();
    await controller.create(who, 1, {});
    expect(createDraft).toHaveBeenCalledWith(who, 1, {});
  });

  it('publish() passes the actor, rewardId and versionId through', async () => {
    const publish = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ publish });
    const who = actor();
    await controller.publish(who, 1, 2);
    expect(publish).toHaveBeenCalledWith(who, 1, 2);
  });

  it('list() delegates the rewardId and wraps the result', async () => {
    const list = jest.fn().mockResolvedValue([{ id: 1 }]);
    const controller = controllerWith({ list });
    const response = await controller.list(1);
    expect(list).toHaveBeenCalledWith(1);
    expect(response.data).toHaveLength(1);
  });

  it('findOne() delegates rewardId and versionId', async () => {
    const getById = jest.fn().mockResolvedValue({ id: 9 });
    const controller = controllerWith({ getById });
    const response = await controller.findOne(1, 9);
    expect(getById).toHaveBeenCalledWith(1, 9);
    expect(response.data).toMatchObject({ id: 9 });
  });

  it('diff() passes rewardId, versionId and otherVersionId through', async () => {
    const diff = jest.fn().mockResolvedValue({ versionId: 1 });
    const controller = controllerWith({ diff });
    await controller.diff(1, 2, 3);
    expect(diff).toHaveBeenCalledWith(1, 2, 3);
  });

  it('countries() delegates rewardId and versionId', async () => {
    const listCountryAssignments = jest.fn().mockResolvedValue([{ id: 1 }]);
    const controller = controllerWith({ listCountryAssignments });
    const response = await controller.countries(1, 2);
    expect(listCountryAssignments).toHaveBeenCalledWith(1, 2);
    expect(response.data).toHaveLength(1);
  });

  it('update() passes the actor, rewardId, versionId and dto through', async () => {
    const updateDraft = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ updateDraft });
    const who = actor();
    await controller.update(who, 1, 2, { deliveryMode: 'batch' });
    expect(updateDraft).toHaveBeenCalledWith(who, 1, 2, { deliveryMode: 'batch' });
  });

  it('deprecate() passes the actor, rewardId and versionId through', async () => {
    const deprecate = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ deprecate });
    const who = actor();
    await controller.deprecate(who, 1, 2);
    expect(deprecate).toHaveBeenCalledWith(who, 1, 2);
  });

  it('retire() passes the actor, rewardId and versionId through', async () => {
    const retire = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ retire });
    const who = actor();
    await controller.retire(who, 1, 2);
    expect(retire).toHaveBeenCalledWith(who, 1, 2);
  });

  it('withdraw() passes the actor, rewardId, versionId and countryId through', async () => {
    const withdrawFromCountry = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith({ withdrawFromCountry });
    const who = actor();
    await controller.withdraw(who, 1, 2, 3);
    expect(withdrawFromCountry).toHaveBeenCalledWith(who, 1, 2, 3);
  });
});
