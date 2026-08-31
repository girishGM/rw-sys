/**
 * T-116 — `RewardCategoriesController`: `@Roles(...ALL_PORTAL_ROLES)` on the class (read-only
 * reference data, matching `rule-categories.controller.ts`'s own precedent), `@RequirePermission`
 * on the four write routes (R6). Same shape `test/rules/rule-categories.controller.spec.ts` and
 * `test/rewards/rewards.controller.spec.ts` establish: the 403/404 behaviour itself is
 * `RolesGuard`'s/`PermissionsGuard`'s and `RewardsService`'s respectively (both already
 * exhaustively tested); this suite proves the controller declares the right authorisation grant
 * per route and delegates without adding logic.
 */
import 'reflect-metadata';
import {
  ALL_PORTAL_ROLES,
  PERMISSION_METADATA_KEY,
  ROLES_METADATA_KEY,
} from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { RewardCategoriesController } from '@/modules/rewards/reward-categories.controller';
import type { RewardsService } from '@/modules/rewards/rewards.service';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function auditOf(handler: (...args: never[]) => unknown): { event: string; targetType?: string } {
  return Reflect.getMetadata(AUDIT_METADATA, handler) as { event: string; targetType?: string };
}

describe('RewardCategoriesController — authorisation metadata (R6)', () => {
  it('is reachable by every role (read-only reference data)', () => {
    const roles = Reflect.getMetadata(
      ROLES_METADATA_KEY,
      RewardCategoriesController,
    ) as readonly string[];
    expect(roles).toEqual(ALL_PORTAL_ROLES);
  });

  it('category writes require reward_category:create/update — super_admin only (T116_002 seed)', () => {
    expect(permissionOf(RewardCategoriesController.prototype.createCategory)).toEqual({
      entity: 'reward_category',
      action: 'create',
    });
    expect(permissionOf(RewardCategoriesController.prototype.updateCategory)).toEqual({
      entity: 'reward_category',
      action: 'update',
    });
  });

  it('sub-category writes require reward_sub_category:create/update', () => {
    expect(permissionOf(RewardCategoriesController.prototype.createSubCategory)).toEqual({
      entity: 'reward_sub_category',
      action: 'create',
    });
    expect(permissionOf(RewardCategoriesController.prototype.updateSubCategory)).toEqual({
      entity: 'reward_sub_category',
      action: 'update',
    });
  });

  it('reads carry no @RequirePermission — gated by the class-level @Roles alone', () => {
    expect(permissionOf(RewardCategoriesController.prototype.listCategories)).toBeUndefined();
    expect(permissionOf(RewardCategoriesController.prototype.listSubCategories)).toBeUndefined();
  });

  it('audits every mutating route', () => {
    expect(auditOf(RewardCategoriesController.prototype.createCategory)).toMatchObject({
      event: 'reward_category_created',
      targetType: 'reward_category',
    });
    expect(auditOf(RewardCategoriesController.prototype.updateCategory)).toMatchObject({
      event: 'reward_category_updated',
      targetType: 'reward_category',
    });
    expect(auditOf(RewardCategoriesController.prototype.createSubCategory)).toMatchObject({
      event: 'reward_sub_category_created',
      targetType: 'reward_sub_category',
    });
    expect(auditOf(RewardCategoriesController.prototype.updateSubCategory)).toMatchObject({
      event: 'reward_sub_category_updated',
      targetType: 'reward_sub_category',
    });
  });
});

describe('RewardCategoriesController — delegation', () => {
  function controllerWith(service: Partial<RewardsService>): RewardCategoriesController {
    return new RewardCategoriesController(service as RewardsService);
  }

  it('listCategories() delegates and wraps in {data}', async () => {
    const listCategories = jest.fn().mockResolvedValue([{ id: 1, categoryCode: 'UNCATEGORIZED' }]);
    const controller = controllerWith({
      listCategories: listCategories as unknown as RewardsService['listCategories'],
    });

    const response = await controller.listCategories();

    expect(listCategories).toHaveBeenCalledWith();
    expect(response.data).toHaveLength(1);
  });

  it('listSubCategories() delegates the optional categoryId', async () => {
    const listSubCategories = jest.fn().mockResolvedValue([]);
    const controller = controllerWith({
      listSubCategories: listSubCategories as unknown as RewardsService['listSubCategories'],
    });

    await controller.listSubCategories(13);
    expect(listSubCategories).toHaveBeenCalledWith(13);

    await controller.listSubCategories(undefined);
    expect(listSubCategories).toHaveBeenCalledWith(undefined);
  });

  it('createCategory()/updateCategory() delegate with the actor', async () => {
    const actor = { userId: 1, role: 'super_admin' } as never;
    const createCategory = jest.fn().mockResolvedValue({ id: 2, categoryCode: 'POINTS' });
    const updateCategory = jest.fn().mockResolvedValue({ id: 2, name: 'Renamed' });
    const controller = controllerWith({
      createCategory: createCategory as unknown as RewardsService['createCategory'],
      updateCategory: updateCategory as unknown as RewardsService['updateCategory'],
    });

    const dto = { categoryCode: 'POINTS', name: 'Points' };
    const createResponse = await controller.createCategory(actor, dto);
    expect(createCategory).toHaveBeenCalledWith(actor, dto);
    expect(createResponse.data).toEqual({ id: 2, categoryCode: 'POINTS' });

    const patch = { name: 'Renamed' };
    const updateResponse = await controller.updateCategory(actor, 2, patch);
    expect(updateCategory).toHaveBeenCalledWith(actor, 2, patch);
    expect(updateResponse.data).toEqual({ id: 2, name: 'Renamed' });
  });

  it('createSubCategory()/updateSubCategory() delegate with the actor', async () => {
    const actor = { userId: 1, role: 'super_admin' } as never;
    const createSubCategory = jest.fn().mockResolvedValue({ id: 5, categoryId: 2 });
    const updateSubCategory = jest.fn().mockResolvedValue({ id: 5, name: 'Renamed' });
    const controller = controllerWith({
      createSubCategory: createSubCategory as unknown as RewardsService['createSubCategory'],
      updateSubCategory: updateSubCategory as unknown as RewardsService['updateSubCategory'],
    });

    const dto = { categoryId: 2, subCategoryCode: 'TIER_1', name: 'Tier 1' };
    const createResponse = await controller.createSubCategory(actor, dto);
    expect(createSubCategory).toHaveBeenCalledWith(actor, dto);
    expect(createResponse.data).toEqual({ id: 5, categoryId: 2 });

    const patch = { name: 'Renamed' };
    const updateResponse = await controller.updateSubCategory(actor, 5, patch);
    expect(updateSubCategory).toHaveBeenCalledWith(actor, 5, patch);
    expect(updateResponse.data).toEqual({ id: 5, name: 'Renamed' });
  });
});
