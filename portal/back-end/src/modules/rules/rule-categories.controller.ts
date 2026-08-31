/**
 * T-031 — `GET /rule-categories`, `GET /rule-sub-categories` (03-API-CONTRACT.md §8: "all
 * (read-only reference data)").
 *
 * `@Roles(...ALL_PORTAL_ROLES)`, no `@RequirePermission` — the same choice `me.controller.ts`
 * and `notifications.controller.ts`'s header explain for "every role" outcomes: this is
 * reference data every role that can see a rule at all needs in order to render the
 * category/sub-category picker, not an entity a runtime permission table should gate for
 * *reading*.
 *
 * T-106 adds real writes on top: `rule_category`/`rule_sub_category` now do have
 * `role_entity_permissions` rows (`super_admin`: `view/create/update`; every other role:
 * `view` only) — the four new endpoints below are gated with `@RequirePermission`, same
 * pattern `rules.controller.ts` uses for `POST`/`PATCH /rules`.
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
import { RULE_CATEGORY_ENTITY, RULE_SUB_CATEGORY_ENTITY } from './rules.constants';
import { RulesService } from './rules.service';
import { CreateRuleCategoryDto } from './dto/create-rule-category.dto';
import { CreateRuleSubCategoryDto } from './dto/create-rule-sub-category.dto';
import { UpdateRuleCategoryDto } from './dto/update-rule-category.dto';
import { UpdateRuleSubCategoryDto } from './dto/update-rule-sub-category.dto';
import {
  envelope,
  type DataEnvelope,
  type RuleCategoryDto,
  type RuleSubCategoryDto,
} from './dto/rule-response.dto';

@Controller()
@Roles(...ALL_PORTAL_ROLES)
export class RuleCategoriesController {
  constructor(private readonly rules: RulesService) {}

  @Get('rule-categories')
  async listCategories(): Promise<DataEnvelope<readonly RuleCategoryDto[]>> {
    return envelope(await this.rules.listCategories());
  }

  @Get('rule-sub-categories')
  async listSubCategories(
    @Query('categoryId', new ParseIntPipe({ optional: true })) categoryId?: number,
  ): Promise<DataEnvelope<readonly RuleSubCategoryDto[]>> {
    return envelope(await this.rules.listSubCategories(categoryId));
  }

  @Post('rule-categories')
  @RequirePermission(RULE_CATEGORY_ENTITY, 'create')
  @Audit({ event: 'rule_category_created', targetType: 'rule_category' })
  async createCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateRuleCategoryDto,
  ): Promise<DataEnvelope<RuleCategoryDto>> {
    return envelope(await this.rules.createCategory(actor, dto));
  }

  @Patch('rule-categories/:id')
  @RequirePermission(RULE_CATEGORY_ENTITY, 'update')
  @Audit({ event: 'rule_category_updated', targetType: 'rule_category' })
  async updateCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRuleCategoryDto,
  ): Promise<DataEnvelope<RuleCategoryDto>> {
    return envelope(await this.rules.updateCategory(actor, id, dto));
  }

  @Post('rule-sub-categories')
  @RequirePermission(RULE_SUB_CATEGORY_ENTITY, 'create')
  @Audit({ event: 'rule_sub_category_created', targetType: 'rule_sub_category' })
  async createSubCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateRuleSubCategoryDto,
  ): Promise<DataEnvelope<RuleSubCategoryDto>> {
    return envelope(await this.rules.createSubCategory(actor, dto));
  }

  @Patch('rule-sub-categories/:id')
  @RequirePermission(RULE_SUB_CATEGORY_ENTITY, 'update')
  @Audit({ event: 'rule_sub_category_updated', targetType: 'rule_sub_category' })
  async updateSubCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRuleSubCategoryDto,
  ): Promise<DataEnvelope<RuleSubCategoryDto>> {
    return envelope(await this.rules.updateSubCategory(actor, id, dto));
  }
}
