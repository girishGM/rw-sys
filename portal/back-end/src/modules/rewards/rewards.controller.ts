/**
 * T-032 — `/rewards` (03-API-CONTRACT.md §9).
 *
 * Thin by design, in the shape `rules.controller.ts` establishes: read the request, call the
 * service, shape the response. The reward-system and country-assignment routes carry
 * `@RequirePermission` (`reward`/`reward_assignment` entities, T004_001's seed) — layer 1 of
 * `RewardsService`'s three-layer authority story (see that file's header).
 *
 * ### Why the policy/cap routes carry `@Roles('super_admin')` instead
 *
 * `role_entity_permissions` has no `reward_policy`/`reward_policy_cap` entity row — T004_001's
 * seed (01-DATABASE.md §5.1) only models rows that encode an actual runtime-configurable
 * authority decision, and 03-API-CONTRACT.md §9 states these three routes as flatly
 * "super_admin", not "all (scope-filtered)" the way the reward-system list route is. `@Roles`
 * alone is a fully supported, independently-guarded pattern (`route-authorisation.ts`,
 * `permissions.guard.ts`'s own comment: *"No `@RequirePermission` on the route ... Passing here
 * is what makes ... `@Roles('super_admin')` alone → 200 ... work"*) — not a weaker check than
 * `@RequirePermission`, just the one that matches what this sub-resource actually needs: a
 * static role gate, since there is no `role_entity_permissions` row a Super Admin could ever
 * hand to another role for it.
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
  Query,
} from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { REWARD_ASSIGNMENT_ENTITY, REWARD_ENTITY } from './rewards.constants';
import { RewardsService } from './rewards.service';
import { AssignRewardCountryDto } from './dto/assign-reward-country.dto';
import { CreateRewardDto } from './dto/create-reward.dto';
import { CreateRewardPolicyCapDto, UpdateRewardPolicyCapDto } from './dto/reward-policy-cap.dto';
import { CreateRewardPolicyDto, UpdateRewardPolicyDto } from './dto/reward-policy.dto';
import { ListRewardsQueryDto } from './dto/list-rewards-query.dto';
import { UpdateRewardDto } from './dto/update-reward.dto';
import {
  envelope,
  type DataEnvelope,
  type DataListEnvelope,
  type RewardCountryAssignmentDto,
  type RewardDto,
  type RewardListItemDto,
} from './dto/reward-response.dto';
import type { RewardPolicyCapDto } from './dto/reward-policy-cap-response.dto';
import type { RewardPolicyDto } from './dto/reward-policy-response.dto';

@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Get()
  @RequirePermission(REWARD_ENTITY, 'view')
  async list(@Query() query: ListRewardsQueryDto): Promise<DataListEnvelope<RewardListItemDto>> {
    const { rows, meta } = await this.rewards.list(query);
    return { data: rows, meta };
  }

  @Get(':id')
  @RequirePermission(REWARD_ENTITY, 'view')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<RewardDto>> {
    return envelope(await this.rewards.getById(id));
  }

  @Post()
  @RequirePermission(REWARD_ENTITY, 'create')
  @Audit({ event: 'reward_created', targetType: 'reward' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateRewardDto,
  ): Promise<DataEnvelope<RewardDto>> {
    return envelope(await this.rewards.create(actor, dto));
  }

  @Patch(':id')
  @RequirePermission(REWARD_ENTITY, 'update')
  @Audit({ event: 'reward_updated', targetType: 'reward' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRewardDto,
  ): Promise<DataEnvelope<RewardDto>> {
    return envelope(await this.rewards.update(actor, id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(REWARD_ENTITY, 'delete')
  @Audit({ event: 'reward_deleted', targetType: 'reward' })
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    await this.rewards.remove(actor, id);
  }

  @Get(':id/countries')
  @RequirePermission(REWARD_ASSIGNMENT_ENTITY, 'view')
  async listCountries(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly RewardCountryAssignmentDto[]>> {
    return envelope(await this.rewards.listCountryAssignments(id));
  }

  @Post(':id/countries')
  @RequirePermission(REWARD_ASSIGNMENT_ENTITY, 'create')
  @Audit({ event: 'reward_assigned', targetType: 'reward_assignment' })
  async assignCountry(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignRewardCountryDto,
  ): Promise<DataEnvelope<RewardCountryAssignmentDto>> {
    return envelope(await this.rewards.assignToCountry(actor, id, dto));
  }

  @Delete(':id/countries/:countryId')
  @HttpCode(204)
  @RequirePermission(REWARD_ASSIGNMENT_ENTITY, 'delete')
  @Audit({ event: 'reward_unassigned', targetType: 'reward_assignment' })
  async unassignCountry(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('countryId', ParseIntPipe) countryId: number,
  ): Promise<void> {
    await this.rewards.unassignFromCountry(actor, id, countryId);
  }

  // --- reward_policies: super_admin only ------------------------------------------------------

  @Get(':id/policies')
  @Roles('super_admin')
  async listPolicies(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly RewardPolicyDto[]>> {
    return envelope(await this.rewards.listPolicies(id));
  }

  @Post(':id/policies')
  @Roles('super_admin')
  @Audit({ event: 'reward_policy_created', targetType: 'reward_policy' })
  async createPolicy(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateRewardPolicyDto,
  ): Promise<DataEnvelope<RewardPolicyDto>> {
    return envelope(await this.rewards.createPolicy(actor, id, dto));
  }

  @Patch(':id/policies/:policyId')
  @Roles('super_admin')
  @Audit({ event: 'reward_policy_updated', targetType: 'reward_policy' })
  async updatePolicy(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('policyId', ParseIntPipe) policyId: number,
    @Body() dto: UpdateRewardPolicyDto,
  ): Promise<DataEnvelope<RewardPolicyDto>> {
    return envelope(await this.rewards.updatePolicy(actor, id, policyId, dto));
  }

  // --- reward_policy_caps: super_admin only (implementation note 5) --------------------------

  @Get(':id/policies/:policyId/caps')
  @Roles('super_admin')
  async listPolicyCaps(
    @Param('id', ParseIntPipe) id: number,
    @Param('policyId', ParseIntPipe) policyId: number,
  ): Promise<DataEnvelope<readonly RewardPolicyCapDto[]>> {
    return envelope(await this.rewards.listPolicyCaps(id, policyId));
  }

  @Post(':id/policies/:policyId/caps')
  @Roles('super_admin')
  @Audit({ event: 'reward_policy_cap_created', targetType: 'reward_policy_cap' })
  async createPolicyCap(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('policyId', ParseIntPipe) policyId: number,
    @Body() dto: CreateRewardPolicyCapDto,
  ): Promise<DataEnvelope<RewardPolicyCapDto>> {
    return envelope(await this.rewards.createPolicyCap(actor, id, policyId, dto));
  }

  @Patch(':id/policies/:policyId/caps/:capId')
  @Roles('super_admin')
  @Audit({ event: 'reward_policy_cap_updated', targetType: 'reward_policy_cap' })
  async updatePolicyCap(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('policyId', ParseIntPipe) policyId: number,
    @Param('capId', ParseIntPipe) capId: number,
    @Body() dto: UpdateRewardPolicyCapDto,
  ): Promise<DataEnvelope<RewardPolicyCapDto>> {
    return envelope(await this.rewards.updatePolicyCap(actor, id, policyId, capId, dto));
  }
}
