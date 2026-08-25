/**
 * T-041 — `/rewards/:rewardId/versions`. Mirrors `RuleVersionsController` exactly — see that
 * file's header for the permission/role reasoning, identical here with `REWARD_ENTITY`.
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
import { REWARD_ENTITY } from '@/modules/rewards/rewards.constants';
import { RewardVersionsService } from './reward-versions.service';
import { CreateVersionDto } from './dto/create-version.dto';
import { UpdateRewardVersionDto } from './dto/update-reward-version.dto';
import {
  envelope,
  type DataEnvelope,
  type RewardVersionDto,
  type VersionCountryAssignmentDto,
  type VersionDiffDto,
} from './dto/version-response.dto';

@Controller('rewards/:rewardId/versions')
export class RewardVersionsController {
  constructor(private readonly versions: RewardVersionsService) {}

  @Get()
  @RequirePermission(REWARD_ENTITY, 'view')
  async list(
    @Param('rewardId', ParseIntPipe) rewardId: number,
  ): Promise<DataEnvelope<readonly RewardVersionDto[]>> {
    return envelope(await this.versions.list(rewardId));
  }

  @Get(':vid')
  @RequirePermission(REWARD_ENTITY, 'view')
  async findOne(
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<RewardVersionDto>> {
    return envelope(await this.versions.getById(rewardId, versionId));
  }

  @Get(':vid/diff/:otherVid')
  @RequirePermission(REWARD_ENTITY, 'view')
  async diff(
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Param('vid', ParseIntPipe) versionId: number,
    @Param('otherVid', ParseIntPipe) otherVersionId: number,
  ): Promise<DataEnvelope<VersionDiffDto>> {
    return envelope(await this.versions.diff(rewardId, versionId, otherVersionId));
  }

  @Get(':vid/countries')
  @RequirePermission(REWARD_ENTITY, 'view')
  async countries(
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<readonly VersionCountryAssignmentDto[]>> {
    return envelope(await this.versions.listCountryAssignments(rewardId, versionId));
  }

  @Post()
  @Roles('super_admin')
  @Audit({ event: 'reward_version_drafted', targetType: 'reward_version' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Body() dto: CreateVersionDto,
  ): Promise<DataEnvelope<RewardVersionDto>> {
    return envelope(await this.versions.createDraft(actor, rewardId, dto));
  }

  @Patch(':vid')
  @Roles('super_admin')
  @Audit({ event: 'reward_version_updated', targetType: 'reward_version' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Param('vid', ParseIntPipe) versionId: number,
    @Body() dto: UpdateRewardVersionDto,
  ): Promise<DataEnvelope<RewardVersionDto>> {
    return envelope(await this.versions.updateDraft(actor, rewardId, versionId, dto));
  }

  @Post(':vid/publish')
  @Roles('super_admin')
  @Audit({ event: 'reward_version_published', targetType: 'reward_version' })
  async publish(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<RewardVersionDto>> {
    return envelope(await this.versions.publish(actor, rewardId, versionId));
  }

  @Post(':vid/deprecate')
  @Roles('super_admin')
  @Audit({ event: 'reward_version_deprecated', targetType: 'reward_version' })
  async deprecate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<RewardVersionDto>> {
    return envelope(await this.versions.deprecate(actor, rewardId, versionId));
  }

  @Post(':vid/retire')
  @Roles('super_admin')
  @Audit({ event: 'reward_version_retired', targetType: 'reward_version' })
  async retire(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Param('vid', ParseIntPipe) versionId: number,
  ): Promise<DataEnvelope<RewardVersionDto>> {
    return envelope(await this.versions.retire(actor, rewardId, versionId));
  }

  @Delete(':vid/countries/:countryId')
  @HttpCode(204)
  @Roles('super_admin')
  @Audit({ event: 'reward_version_withdrawn', targetType: 'reward_version_assignment' })
  async withdraw(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('rewardId', ParseIntPipe) rewardId: number,
    @Param('vid', ParseIntPipe) versionId: number,
    @Param('countryId', ParseIntPipe) countryId: number,
  ): Promise<void> {
    await this.versions.withdrawFromCountry(actor, rewardId, versionId, countryId);
  }
}
