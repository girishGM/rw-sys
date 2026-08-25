/**
 * T-041 — `/rules/:ruleId/versions` (06-VERSIONING.md §10 "Versions tab").
 *
 * Thin by design, the shape `rules.controller.ts` establishes. Read routes carry
 * `@RequirePermission(RULE_ENTITY, 'view')` — reused rather than a dedicated `version` entity,
 * see `versions.constants.ts`'s header for why. Write routes carry `@Roles('super_admin')`,
 * the same static-role precedent `rewards.controller.ts` sets for `reward_policy`/
 * `reward_policy_cap`.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { RULE_ENTITY } from '@/modules/rules/rules.constants';
import { RuleVersionsService } from './rule-versions.service';
import { CreateVersionDto } from './dto/create-version.dto';
import { UpdateRuleVersionDto } from './dto/update-rule-version.dto';
import {
  envelope,
  type DataEnvelope,
  type RuleVersionDto,
  type VersionCountryAssignmentDto,
  type VersionDiffDto,
} from './dto/version-response.dto';

@Controller('rules/:ruleId/versions')
export class RuleVersionsController {
  constructor(private readonly versions: RuleVersionsService) {}

  @Get()
  @RequirePermission(RULE_ENTITY, 'view')
  async list(
    @Param('ruleId', ParseIntPipe) ruleId: number,
  ): Promise<DataEnvelope<readonly RuleVersionDto[]>> {
    return envelope(await this.versions.list(ruleId));
  }

  @Get(':vid')
  @RequirePermission(RULE_ENTITY, 'view')
  async findOne(
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<RuleVersionDto>> {
    return envelope(await this.versions.getById(ruleId, versionId));
  }

  @Get(':vid/diff/:otherVid')
  @RequirePermission(RULE_ENTITY, 'view')
  async diff(
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Param('vid', ParseIntPipe) versionId: number,
    @Param('otherVid', ParseIntPipe) otherVersionId: number,
  ): Promise<DataEnvelope<VersionDiffDto>> {
    return envelope(await this.versions.diff(ruleId, versionId, otherVersionId));
  }

  @Get(':vid/countries')
  @RequirePermission(RULE_ENTITY, 'view')
  async countries(
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<readonly VersionCountryAssignmentDto[]>> {
    return envelope(await this.versions.listCountryAssignments(ruleId, versionId));
  }

  @Post()
  @Roles('super_admin')
  @Audit({ event: 'rule_version_drafted', targetType: 'rule_version' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Body() dto: CreateVersionDto,
  ): Promise<DataEnvelope<RuleVersionDto>> {
    return envelope(await this.versions.createDraft(actor, ruleId, dto));
  }

  @Patch(':vid')
  @Roles('super_admin')
  @Audit({ event: 'rule_version_updated', targetType: 'rule_version' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Param('vid', ParseIntPipe) versionId: number,
    @Body() dto: UpdateRuleVersionDto,
  ): Promise<DataEnvelope<RuleVersionDto>> {
    return envelope(await this.versions.updateDraft(actor, ruleId, versionId, dto));
  }

  @Post(':vid/publish')
  @Roles('super_admin')
  @Audit({ event: 'rule_version_published', targetType: 'rule_version' })
  async publish(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<RuleVersionDto>> {
    return envelope(await this.versions.publish(actor, ruleId, versionId));
  }

  @Post(':vid/deprecate')
  @Roles('super_admin')
  @Audit({ event: 'rule_version_deprecated', targetType: 'rule_version' })
  async deprecate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<RuleVersionDto>> {
    return envelope(await this.versions.deprecate(actor, ruleId, versionId));
  }

  @Post(':vid/retire')
  @Roles('super_admin')
  @Audit({ event: 'rule_version_retired', targetType: 'rule_version' })
  async retire(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<RuleVersionDto>> {
    return envelope(await this.versions.retire(actor, ruleId, versionId));
  }

  @Delete(':vid/countries/:countryId')
  @HttpCode(204)
  @Roles('super_admin')
  @Audit({ event: 'rule_version_withdrawn', targetType: 'rule_version_assignment' })
  async withdraw(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Param('vid', ParseIntPipe) versionId: number,
    @Param('countryId', ParseIntPipe) countryId: number,
  ): Promise<void> {
    await this.versions.withdrawFromCountry(actor, ruleId, versionId, countryId);
  }
}
