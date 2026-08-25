/**
 * T-031 — `RuleCategoriesController`: `@Roles(...ALL_PORTAL_ROLES)`, read-only reference data
 * (03-API-CONTRACT.md §8). See the controller's own header for why `@Roles`, not
 * `@RequirePermission`.
 */
import 'reflect-metadata';
import { ALL_PORTAL_ROLES, ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { RuleCategoriesController } from '@/modules/rules/rule-categories.controller';
import type { RulesService } from '@/modules/rules/rules.service';

describe('RuleCategoriesController', () => {
  it('is reachable by every role', () => {
    const roles = Reflect.getMetadata(
      ROLES_METADATA_KEY,
      RuleCategoriesController,
    ) as readonly string[];
    expect(roles).toEqual(ALL_PORTAL_ROLES);
  });

  it('listCategories() delegates', async () => {
    const listCategories = jest.fn().mockResolvedValue([{ id: 1, categoryCode: 'TRANSACTION' }]);
    const controller = new RuleCategoriesController({ listCategories } as unknown as RulesService);

    const response = await controller.listCategories();

    expect(listCategories).toHaveBeenCalledWith();
    expect(response.data).toHaveLength(1);
  });

  it('listSubCategories() delegates the optional categoryId', async () => {
    const listSubCategories = jest.fn().mockResolvedValue([]);
    const controller = new RuleCategoriesController({
      listSubCategories,
    } as unknown as RulesService);

    await controller.listSubCategories(13);
    expect(listSubCategories).toHaveBeenCalledWith(13);

    await controller.listSubCategories(undefined);
    expect(listSubCategories).toHaveBeenCalledWith(undefined);
  });
});
