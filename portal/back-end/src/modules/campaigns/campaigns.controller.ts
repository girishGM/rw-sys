/**
 * T-037 — `/campaigns` (03-API-CONTRACT.md §11).
 *
 * Thin by design, the same shape `merchants.controller.ts` and `tenants.controller.ts`
 * establish: read the request, call the service, shape the response. Every route carries
 * `@RequirePermission(CAMPAIGN_ENTITY, ...)` against `role_entity_permissions`; the
 * `assertRole(actor, 'maker')` that actually decides authorship lives in the **service**, per
 * `assert-role.ts`'s own instruction (*"at the top of the service method, not in the
 * controller"*) — so the AI agent backend (T-048), a future CLI or a queue consumer meets the
 * same rule this controller does.
 *
 * ### The `submit` action's permission, and why it is not `update`
 *
 * T004_001 seeds `maker` with `['view','create','update','submit']` on the `campaign` entity.
 * `POST /:id/submit` therefore requires `submit`, not `update`: they are genuinely different
 * authorities — a Super Admin editing the Access Control screen can grant one without the other,
 * which is exactly the granularity 00-ARCHITECTURE.md §7's data-driven permission model exists
 * to provide.
 *
 * ### Route order
 *
 * `GET /:id/...` sub-resources are declared **before** `GET /:id`, because Nest matches in
 * declaration order and `:id` would otherwise swallow `review`, `journey` and the rest.
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
  Put,
  Query,
} from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import type {
  Campaign,
  CampaignActivityOption,
  CampaignAuditEntry,
  CampaignCapsResponse,
  CampaignMerchantLink,
  CampaignReview,
  Journey,
  RewardLevel,
  RewardOption,
  RuleOption,
  SubmitCampaignResponse,
} from '@reward-portal/shared';
import { CAMPAIGN_ENTITY } from './campaigns.constants';
import { CampaignsService } from './campaigns.service';
import { JourneyService } from './journey.service';
import { BindingsService } from './bindings.service';
import { CapsService } from './caps.service';
import {
  CreateCampaignDto,
  ListCampaignsQueryDto,
  SetCampaignMerchantsDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';
import {
  CreateComponentDto,
  CreateTrackerDto,
  ReorderComponentsDto,
  UpdateComponentDto,
  UpdateTrackerDto,
} from './dto/journey.dto';
import {
  AttachRewardDto,
  BindComponentRuleDto,
  UpdateComponentRuleValuesDto,
} from './dto/binding.dto';
import { PutCampaignCapsDto } from './dto/caps.dto';
import { envelope, type DataEnvelope, type DataListEnvelope } from './dto/campaign-response.dto';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly journey: JourneyService,
    private readonly bindings: BindingsService,
    private readonly caps: CapsService,
  ) {}

  // --- campaign ------------------------------------------------------------------------------

  @Get()
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async list(@Query() query: ListCampaignsQueryDto): Promise<DataListEnvelope<Campaign>> {
    const { rows, meta } = await this.campaigns.list(query);
    return { data: rows, meta };
  }

  @Post()
  @RequirePermission(CAMPAIGN_ENTITY, 'create')
  @Audit({ event: 'campaign_created', targetType: 'campaign' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateCampaignDto,
  ): Promise<DataEnvelope<Campaign>> {
    return envelope(await this.campaigns.create(actor, dto));
  }

  // --- sub-resources, declared before `:id` (see this file's header) --------------------------

  @Get(':id/merchants')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async listMerchants(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly CampaignMerchantLink[]>> {
    await this.campaigns.loadCampaign(id);
    return envelope(await this.campaigns.listMerchants(id));
  }

  @Get(':id/activities')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async listActivities(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly CampaignActivityOption[]>> {
    await this.campaigns.loadCampaign(id);
    return envelope(await this.journey.listActivityOptions(id));
  }

  @Get(':id/journey')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async getJourney(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<Journey>> {
    await this.campaigns.loadCampaign(id);
    return envelope(await this.campaigns.getJourney(id));
  }

  /** The step-3 rule picker (TC-14). Scoped to the actor's country by `ScopedRepository` — see
   * `bindings.service.ts`'s header on `ruleVisibilityScope()`. */
  @Get(':id/rule-options')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async listRuleOptions(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly RuleOption[]>> {
    await this.campaigns.loadCampaign(id);
    return envelope(await this.bindings.listRuleOptions());
  }

  /** The step-5 reward picker (TC-21). */
  @Get(':id/reward-options')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async listRewardOptions(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly RewardOption[]>> {
    await this.campaigns.loadCampaign(id);
    return envelope(await this.bindings.listRewardOptions());
  }

  @Get(':id/caps')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async getCaps(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<CampaignCapsResponse>> {
    const campaign = await this.campaigns.loadCampaign(id);
    return envelope(await this.caps.get(campaign));
  }

  @Get(':id/review')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async review(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<CampaignReview>> {
    return envelope(await this.campaigns.review(id));
  }

  @Get(':id/audit')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async listAudit(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ListCampaignsQueryDto,
  ): Promise<DataListEnvelope<CampaignAuditEntry>> {
    const { rows, meta } = await this.campaigns.listAudit(id, query.page, query.pageSize);
    return { data: rows, meta };
  }

  @Get(':id')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<Campaign>> {
    return envelope(await this.campaigns.getById(id));
  }

  @Patch(':id')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_updated', targetType: 'campaign' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCampaignDto,
  ): Promise<DataEnvelope<Campaign>> {
    return envelope(await this.campaigns.update(actor, id, dto));
  }

  // --- step 2 --------------------------------------------------------------------------------

  @Post(':id/merchants')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_merchants_set', targetType: 'campaign' })
  async setMerchants(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetCampaignMerchantsDto,
  ): Promise<DataEnvelope<readonly CampaignMerchantLink[]>> {
    return envelope(await this.campaigns.setMerchants(actor, id, dto));
  }

  // --- step 3: the journey builder -----------------------------------------------------------

  @Post(':id/trackers')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_tracker_created', targetType: 'campaign' })
  async createTracker(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateTrackerDto,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.journey.createTracker(actor, campaign, dto);
    return envelope(await this.campaigns.getJourney(id));
  }

  @Patch(':id/trackers/:trackerId')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_tracker_updated', targetType: 'campaign' })
  async updateTracker(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('trackerId', ParseIntPipe) trackerId: number,
    @Body() dto: UpdateTrackerDto,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.journey.updateTracker(actor, campaign, trackerId, dto);
    return envelope(await this.campaigns.getJourney(id));
  }

  @Delete(':id/trackers/:trackerId')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_tracker_deleted', targetType: 'campaign' })
  async removeTracker(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('trackerId', ParseIntPipe) trackerId: number,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.journey.removeTracker(actor, campaign, trackerId);
    return envelope(await this.campaigns.getJourney(id));
  }

  @Post(':id/trackers/:trackerId/components')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_component_created', targetType: 'campaign' })
  async createComponent(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('trackerId', ParseIntPipe) trackerId: number,
    @Body() dto: CreateComponentDto,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.journey.createComponent(actor, campaign, trackerId, dto);
    return envelope(await this.campaigns.getJourney(id));
  }

  @Patch(':id/trackers/:trackerId/order')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_components_reordered', targetType: 'campaign' })
  async reorder(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('trackerId', ParseIntPipe) trackerId: number,
    @Body() dto: ReorderComponentsDto,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.journey.reorderComponents(actor, campaign, trackerId, dto);
    return envelope(await this.campaigns.getJourney(id));
  }

  @Patch(':id/components/:componentId')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_component_updated', targetType: 'campaign' })
  async updateComponent(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('componentId', ParseIntPipe) componentId: number,
    @Body() dto: UpdateComponentDto,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.journey.updateComponent(actor, campaign, componentId, dto);
    return envelope(await this.campaigns.getJourney(id));
  }

  @Delete(':id/components/:componentId')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_component_deleted', targetType: 'campaign' })
  async removeComponent(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('componentId', ParseIntPipe) componentId: number,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.journey.removeComponent(actor, campaign, componentId);
    return envelope(await this.campaigns.getJourney(id));
  }

  // --- step 4: rule binding ------------------------------------------------------------------

  @Post(':id/rules')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_rule_bound', targetType: 'campaign' })
  async bindRule(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BindComponentRuleDto,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.bindings.bindRule(actor, campaign, dto);
    return envelope(await this.campaigns.getJourney(id));
  }

  @Patch(':id/rules/:bindingId')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_rule_values_updated', targetType: 'campaign' })
  async updateRuleValues(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('bindingId', ParseIntPipe) bindingId: number,
    @Body() dto: UpdateComponentRuleValuesDto,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.bindings.updateRuleValues(actor, campaign, bindingId, dto);
    return envelope(await this.campaigns.getJourney(id));
  }

  @Delete(':id/rules/:bindingId')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_rule_unbound', targetType: 'campaign' })
  async unbindRule(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('bindingId', ParseIntPipe) bindingId: number,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.bindings.unbindRule(actor, campaign, bindingId);
    return envelope(await this.campaigns.getJourney(id));
  }

  // --- step 5: rewards -----------------------------------------------------------------------

  @Post(':id/rewards')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_reward_attached', targetType: 'campaign' })
  async attachReward(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AttachRewardDto,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.bindings.attachReward(actor, campaign, dto);
    return envelope(await this.campaigns.getJourney(id));
  }

  @Delete(':id/rewards/:level/:assignmentId')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_reward_detached', targetType: 'campaign' })
  async detachReward(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('level') level: string,
    @Param('assignmentId', ParseIntPipe) assignmentId: number,
  ): Promise<DataEnvelope<Journey>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    await this.bindings.detachReward(actor, campaign, asRewardLevel(level), assignmentId);
    return envelope(await this.campaigns.getJourney(id));
  }

  // --- step 6: budgets and limits ------------------------------------------------------------

  @Put(':id/caps')
  @RequirePermission(CAMPAIGN_ENTITY, 'update')
  @Audit({ event: 'campaign_caps_set', targetType: 'campaign' })
  async putCaps(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PutCampaignCapsDto,
  ): Promise<DataEnvelope<CampaignCapsResponse>> {
    const campaign = await this.campaigns.loadEditableCampaign(id);
    return envelope(await this.caps.put(actor, campaign, dto));
  }

  // --- step 7: submit ------------------------------------------------------------------------

  /**
   * `POST /campaigns/:id/submit`. 200 rather than 201 — nothing addressable is created for the
   * caller; the campaign it names changes state.
   */
  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission(CAMPAIGN_ENTITY, 'submit')
  @Audit({ event: 'campaign_submitted', targetType: 'campaign' })
  async submit(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<SubmitCampaignResponse>> {
    return envelope(await this.campaigns.submit(actor, id));
  }

  // --- run-time state: pause and resume (T-047) -----------------------------------------------

  /**
   * `POST /campaigns/:id/pause` — 03-API-CONTRACT.md §11, `tenant_admin`.
   *
   * Added by T-047; see `campaigns.service.ts#pause` for why that task built a route §11 has
   * always specified and no task ever owned. 200 rather than 201 for the same reason `submit`
   * is: nothing is created, an existing campaign changes state.
   *
   * The `pause`/`resume` actions come from `T047_003`, which grants them to `tenant_admin` — the
   * role §11 names. A `maker` cannot pause a live campaign and a `checker` approves rather than
   * operates, so neither has the action.
   */
  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermission(CAMPAIGN_ENTITY, 'pause')
  @Audit({ event: 'campaign_paused', targetType: 'campaign' })
  async pause(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<Campaign>> {
    return envelope(await this.campaigns.pause(actor, id));
  }

  /** `POST /campaigns/:id/resume` — the mirror of {@link pause}. */
  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission(CAMPAIGN_ENTITY, 'resume')
  @Audit({ event: 'campaign_resumed', targetType: 'campaign' })
  async resume(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<Campaign>> {
    return envelope(await this.campaigns.resume(actor, id));
  }
}

/**
 * The `:level` path segment, narrowed.
 *
 * An unrecognised value falls back to `campaign`, whose delete path is itself scoped to this
 * campaign's own assignments — so a hand-crafted `/rewards/nonsense/1` finds nothing and 404s
 * rather than reaching a branch that was never meant to run. Throwing here would be equally
 * correct; falling through to a scoped lookup keeps the failure indistinguishable from "no such
 * assignment", which is the shape 02-SECURITY.md §5.1 asks for.
 */
function asRewardLevel(value: string): RewardLevel {
  return value === 'tracker' || value === 'component' ? value : 'campaign';
}
