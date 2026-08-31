/**
 * T-116 — `GET/POST/PATCH /reward-categories`, `/reward-sub-categories`. The reward equivalent
 * of `rule-categories.controller.ts` (T-106), same shape throughout:
 *
 * `@Roles(...ALL_PORTAL_ROLES)` on the class — the two `GET` routes are read-only reference
 * data every role that can see a reward at all needs, to render a category/sub-category picker,
 * not an entity a runtime permission table should gate for *reading* (matching
 * `rule-categories.controller.ts`'s own header). `T116_002` adds real permission rows for the
 * write actions only: `reward_category`/`reward_sub_category` (`super_admin`: `view/create/
 * update`; every other role: `view` only) — the four routes below carry `@RequirePermission` on
 * top of the class-level `@Roles`, same pattern `rule-categories.controller.ts` uses.
 */
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { REWARD_CATEGORY_ENTITY, REWARD_SUB_CATEGORY_ENTITY } from './rewards.constants';
import { RewardsService } from './rewards.service';
import {
  CreateRewardCategoryDto,
  CreateRewardSubCategoryDto,
  UpdateRewardCategoryDto,
  UpdateRewardSubCategoryDto,
} from './dto/reward-category.dto';
import type { RewardCategoryDto, RewardSubCategoryDto } from './dto/reward-category-response.dto';
import { envelope, type DataEnvelope } from './dto/reward-response.dto';

@Controller()
@Roles(...ALL_PORTAL_ROLES)
export class RewardCategoriesController {
  constructor(private readonly rewards: RewardsService) {}

  @Get('reward-categories')
  async listCategories(): Promise<DataEnvelope<readonly RewardCategoryDto[]>> {
    return envelope(await this.rewards.listCategories());
  }

  @Get('reward-sub-categories')
  async listSubCategories(
    @Query('categoryId', new ParseIntPipe({ optional: true })) categoryId?: number,
  ): Promise<DataEnvelope<readonly RewardSubCategoryDto[]>> {
    return envelope(await this.rewards.listSubCategories(categoryId));
  }

  @Post('reward-categories')
  @RequirePermission(REWARD_CATEGORY_ENTITY, 'create')
  @Audit({ event: 'reward_category_created', targetType: 'reward_category' })
  async createCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateRewardCategoryDto,
  ): Promise<DataEnvelope<RewardCategoryDto>> {
    return envelope(await this.rewards.createCategory(actor, dto));
  }

  @Patch('reward-categories/:id')
  @RequirePermission(REWARD_CATEGORY_ENTITY, 'update')
  @Audit({ event: 'reward_category_updated', targetType: 'reward_category' })
  async updateCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRewardCategoryDto,
  ): Promise<DataEnvelope<RewardCategoryDto>> {
    return envelope(await this.rewards.updateCategory(actor, id, dto));
  }

  @Post('reward-sub-categories')
  @RequirePermission(REWARD_SUB_CATEGORY_ENTITY, 'create')
  @Audit({ event: 'reward_sub_category_created', targetType: 'reward_sub_category' })
  async createSubCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateRewardSubCategoryDto,
  ): Promise<DataEnvelope<RewardSubCategoryDto>> {
    return envelope(await this.rewards.createSubCategory(actor, dto));
  }

  @Patch('reward-sub-categories/:id')
  @RequirePermission(REWARD_SUB_CATEGORY_ENTITY, 'update')
  @Audit({ event: 'reward_sub_category_updated', targetType: 'reward_sub_category' })
  async updateSubCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRewardSubCategoryDto,
  ): Promise<DataEnvelope<RewardSubCategoryDto>> {
    return envelope(await this.rewards.updateSubCategory(actor, id, dto));
  }
}
