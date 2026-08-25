/**
 * T-031 — `GET /rule-categories`, `GET /rule-sub-categories` (03-API-CONTRACT.md §8: "all
 * (read-only reference data)").
 *
 * `@Roles(...ALL_PORTAL_ROLES)`, no `@RequirePermission` — the same choice `me.controller.ts`
 * and `notifications.controller.ts`'s header explain for "every role" outcomes: there is no
 * `rule_category`/`rule_sub_category` row in `role_entity_permissions` (01-DATABASE.md §5.1
 * lists no such entity — only the rows that model an actual authority decision do), so there
 * is nothing for Super Admin to revoke here. This is reference data every role that can see a
 * rule at all needs in order to render the category/sub-category picker, not an entity a
 * runtime permission table should be able to gate.
 */
import { Controller, Get, ParseIntPipe, Query } from '@nestjs/common';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { RulesService } from './rules.service';
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
}
