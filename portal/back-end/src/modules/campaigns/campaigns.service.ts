/**
 * T-037 — `/campaigns`: the campaign itself, the assembled journey tree, step 7's review, and
 * submission.
 *
 * ### The three independent layers behind every write here
 *
 * The same shape `merchants.service.ts` and `tenants.service.ts` establish, one link further
 * along the delegation chain:
 *
 *  1. **Permission layer** — `role_entity_permissions` grants `campaign:create`/`update`/`submit`
 *     to `maker` only (T004_001's seed); `checker` holds `view`/`approve`/`reject`/`return`, and
 *     `super_admin`/`country_admin`/`tenant_admin`/`merchant` hold `view` alone. That is TC-2 and
 *     TC-3.
 *  2. **Service layer** — `assertRole(actor, 'maker')` at the top of every mutating method,
 *     independent of what the permission table says. T-013's own TC-19 is the scenario: one
 *     `UPDATE role_entity_permissions` should not turn a checker into an author.
 *  3. **Data layer** — `ScopedRepository`'s declared strategy for `TenantCampaign` makes a maker
 *     structurally unable to reach another tenant's campaign (TC-4/TC-5 — a 404, not a 403), and
 *     forces `tenant_id` onto every INSERT from the actor's own scope regardless of the body.
 *     `CreateCampaignDto` has no `tenantId` field at all (R3), so that is two independent
 *     controls rather than one.
 *
 * ### `submit` is the only method that refuses on a budget
 *
 * Implementation note 17 / 11-BUDGETS-AND-LIMITS.md §8.4: *"Draft saving is never blocked — a
 * maker may draft anything; the gate is submission"* (TC-21gg), and the gate itself is
 * **service-layer**, *"independent of the UI, because the UI is not a control"* (TC-21kk). Both
 * halves matter: a `curl` straight at `POST /campaigns/:id/submit` meets the same 422 a browser
 * would, and a `PUT /caps` above the ceiling still saves.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Op, UniqueConstraintError, type Transaction, type WhereOptions } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { CampaignMerchant, Merchant, TenantCampaign } from '@/database/models';
import {
  PortalApprovalRequest,
  PortalCampaignAuditTrail,
  PortalUser,
} from '@/database/portal-models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { NOTIFICATION_TYPE } from '@/modules/notifications/notifications.constants';
import { ChangeEventPublisher } from '@/grpc/change-event.publisher';
import { BREACH_AUDIT_EVENT, SYSTEM_ACTOR_ROLE } from '@/grpc/grpc.constants';
import type {
  Campaign,
  CampaignAuditEntry,
  CampaignMerchantLink,
  CampaignReview,
  Journey,
  JourneyComponent,
  JourneyTracker,
  RewardAssignment,
  SubmitCampaignResponse,
} from '@reward-portal/shared';
import { actorRefId, actorRefText } from './actor-ref';
import { calendarDateOf, toStoredCampaignDate } from './campaign-date';
import { assertTransition, isEditable } from './campaign-state-machine';
import {
  APPROVAL_ACTION_CREATE,
  APPROVAL_ENTITY_CAMPAIGN,
  APPROVAL_EXPIRY_DAYS,
  APPROVAL_STATUS,
  AUDIT_ACTION,
  AUDIT_ENTITY,
  CAMPAIGN_STATUS,
  DEFAULT_PAGE_SIZE,
  MAX_CHECKERS_NOTIFIED,
  MAX_PAGE_SIZE,
  ROW_ACTIVE,
  ROW_INACTIVE,
} from './campaigns.constants';
import {
  BudgetExceedsTenantCeilingError,
  CampaignCodeExistsError,
  CampaignNotEditableError,
  CampaignStructureIncompleteError,
  MerchantNotInTenantError,
} from './campaigns.errors';
import { CampaignAuditService } from './campaign-audit.service';
import { JourneyService } from './journey.service';
import { BindingsService } from './bindings.service';
import { CapsService } from './caps.service';
import { ceilingBreaches, worstCasePayout } from './budget-analysis';
import {
  structuralIssueDetails,
  validateStructure,
  type ComponentShape,
  type TrackerShape,
} from './structural-validation';
import {
  toCampaignAuditDto,
  toCampaignCapDto,
  toCampaignDto,
  toCampaignMerchantDto,
  type ListMeta,
} from './dto/campaign-response.dto';
import type {
  CreateCampaignDto,
  ListCampaignsQueryDto,
  SetCampaignMerchantsDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

/**
 * How a campaign came to exist, when it was not a maker working through the wizard (T-048).
 *
 * Recorded in the audit trail only — see {@link CampaignsService.create}. Kept in this module
 * rather than in `campaign-agent/` because it is `CampaignsService`'s own parameter type, and a
 * service whose signature reaches into a consumer's module for a type has the dependency the wrong
 * way round.
 */
export interface CampaignProvenance {
  /** `'ai_agent'` today. A short, stable marker a checker's UI can switch on. */
  readonly createdVia: string;
  /** The `reward_portal.agent_sessions` uuid whose conversation produced this campaign. */
  readonly agentSessionId: string;
}

const SORT_COLUMN: Readonly<Record<string, string>> = Object.freeze({
  campaignCode: 'campaignCode',
  name: 'name',
  createdAt: 'createdAt',
  status: 'status',
  startDate: 'startDate',
});

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: CampaignAuditService,
    private readonly journey: JourneyService,
    private readonly bindings: BindingsService,
    private readonly caps: CapsService,
    private readonly notifications: NotificationsService,
    // T-047. Both are about what happens *after* a campaign changes state, not about authoring:
    // `AuditService` writes the `portal_audit_log` row 09-INTEGRATION.md §7a requires for a
    // breach-triggered pause, and `ChangeEventPublisher` is the seam the runtime's
    // `WatchCampaignConfig` stream reads (§9). Neither is touched by any path that predates T-047.
    private readonly portalAudit: AuditService,
    private readonly changeEvents: ChangeEventPublisher,
  ) {}

  // --- reads ---------------------------------------------------------------------------------

  /** `GET /campaigns`. Scope alone decides visibility — no role branch in this method (TC-4). */
  async list(query: ListCampaignsQueryDto): Promise<{ rows: Campaign[]; meta: ListMeta }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const [field, direction] = parseSort(query.sort);
    const where = buildWhere(query);

    const rows = await this.scoped.listAll(TenantCampaign, {
      where,
      order: [[SORT_COLUMN[field], direction.toUpperCase()]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const total = await this.scoped.count(TenantCampaign, { where });

    const approvals = await this.latestApprovalsByCampaign(rows.map((row) => row.id));
    return {
      rows: rows.map((row) => toCampaignDto(row, approvalContext(approvals.get(row.id)))),
      meta: { page, pageSize, total },
    };
  }

  /** `GET /campaigns/:id`. A campaign outside the actor's scope 404s here, indistinguishably
   * from one that does not exist (TC-4, 02-SECURITY.md §5.1). */
  async getById(id: number): Promise<Campaign> {
    const campaign = await this.loadCampaign(id);
    const approvals = await this.latestApprovalsByCampaign([id]);
    return toCampaignDto(campaign, approvalContext(approvals.get(id)));
  }

  /** The scoped row itself, for the controller and for every sibling service. */
  async loadCampaign(id: number, transaction?: Transaction): Promise<TenantCampaign> {
    return this.scoped.findByPkOrFail(TenantCampaign, id, { transaction });
  }

  /** The scoped row, refused unless it is still editable (implementation note 3). */
  async loadEditableCampaign(id: number, transaction?: Transaction): Promise<TenantCampaign> {
    const campaign = await this.loadCampaign(id, transaction);
    if (!isEditable(campaign.status)) throw new CampaignNotEditableError(campaign.status);
    return campaign;
  }

  // --- writes --------------------------------------------------------------------------------

  /**
   * `POST /campaigns` — step 1 (TC-1). `status='draft'`, `created_by` = the maker's id as a
   * string (gap G5, `actorRefText`).
   *
   * ### `provenance` (added by T-048)
   *
   * Optional, absent for every wizard call, and **not** part of `CreateCampaignDto` — deliberately.
   * 10-AI-CAMPAIGN-AGENT.md §7 requires the audit row of an AI-assisted campaign to record
   * *"`created_via: 'ai_agent'` plus the session id, so a checker can see a campaign was AI-assisted
   * and read the conversation behind it"*. A DTO field would mean a `curl` could claim to be the
   * agent (or deny being it), which is the opposite of provenance; a service parameter can only be
   * set by a caller in this process, and the only caller that sets it is `portal-api.client.ts`.
   *
   * The campaign **row** is unaffected — nothing about the created campaign differs (T-048 TC-26,
   * *"byte-identical DB rows apart from `created_via`"*). Only the audit trail's `field_changes`
   * gains two keys.
   */
  async create(
    actor: AuthenticatedUser,
    dto: CreateCampaignDto,
    provenance?: CampaignProvenance,
  ): Promise<Campaign> {
    assertRole(actor, 'maker');

    const campaign = await this.sequelize.transaction(async (transaction) => {
      try {
        const created = await this.scoped.create(
          TenantCampaign,
          {
            // `tenantId` is forced from the actor's scope by `ScopedRepository` regardless of
            // what is written here; supplying it explicitly would be redundant and misleading, so
            // it is not — the DTO has no such field either (R3).
            campaignCode: dto.campaignCode,
            name: dto.name.trim(),
            description: dto.description ?? null,
            // T-065 — a calendar date stored as UTC midnight, never the instant the client
            // happened to phrase it as. See `campaign-date.ts`.
            startDate: toStoredCampaignDate(dto.startDate),
            endDate: toStoredCampaignDate(dto.endDate),
            status: CAMPAIGN_STATUS.DRAFT,
            maxParticipants: dto.maxParticipants ?? null,
            budgetAmount: dto.budgetAmount ?? null,
            budgetCurrency: dto.budgetCurrency ?? null,
            // gap G5 / implementation note 2 — `varchar(100)`, so the id as a string.
            createdBy: actorRefText(actor),
            approvedBy: null,
            approvedAt: null,
            definitionPinnedAt: null,
          } as never,
          { transaction },
        );

        await this.audit.record(
          actor,
          {
            tenantId: created.tenantId,
            campaignId: created.id,
            entityType: AUDIT_ENTITY.CAMPAIGN,
            action: AUDIT_ACTION.CREATED,
            entityId: created.id,
            fieldChanges: {
              campaignCode: created.campaignCode,
              name: created.name,
              // Absent entirely for a wizard-built campaign, so the two are distinguishable by
              // the presence of the key rather than by a sentinel value nobody would notice.
              ...(provenance === undefined
                ? {}
                : {
                    created_via: provenance.createdVia,
                    agent_session_id: provenance.agentSessionId,
                  }),
            },
          },
          transaction,
        );

        return created;
      } catch (error) {
        // `uq_tc_tenant_code` — TC-6. TC-7 (the same code in another tenant) never reaches here,
        // because the constraint is per tenant and `tenant_id` came from the actor's scope.
        if (error instanceof UniqueConstraintError) {
          throw new CampaignCodeExistsError({ cause: error });
        }
        throw error;
      }
    });

    return toCampaignDto(campaign, { lastApprovalStatus: null, lastReviewComment: null });
  }

  /** `PATCH /campaigns/:id` — draft only (TC-5: a cross-tenant patch 404s and changes nothing). */
  async update(actor: AuthenticatedUser, id: number, dto: UpdateCampaignDto): Promise<Campaign> {
    assertRole(actor, 'maker');

    const campaign = await this.sequelize.transaction(async (transaction) => {
      const existing = await this.loadEditableCampaign(id, transaction);

      const changes: Record<string, unknown> = {};
      if (dto.name !== undefined) changes['name'] = dto.name.trim();
      if (dto.description !== undefined) changes['description'] = dto.description;
      if (dto.startDate !== undefined) changes['startDate'] = toStoredCampaignDate(dto.startDate);
      if (dto.endDate !== undefined) changes['endDate'] = toStoredCampaignDate(dto.endDate);
      if (dto.maxParticipants !== undefined) changes['maxParticipants'] = dto.maxParticipants;
      if (dto.budgetAmount !== undefined) changes['budgetAmount'] = dto.budgetAmount;
      if (dto.budgetCurrency !== undefined) changes['budgetCurrency'] = dto.budgetCurrency;

      if (Object.keys(changes).length > 0) {
        await this.scoped.update(TenantCampaign, changes, { where: { id }, transaction });
      }

      const reloaded = await this.loadCampaign(id, transaction);
      await this.audit.record(
        actor,
        {
          tenantId: reloaded.tenantId,
          campaignId: id,
          entityType: AUDIT_ENTITY.CAMPAIGN,
          entityId: id,
          action: AUDIT_ACTION.UPDATED,
          // The audit trail records the **calendar dates** a maker actually changed (T-065), not
          // the instants they are stored as: "endDate: 2027-02-15 → 2027-02-20" is what a checker
          // reading this row needs, and an ISO instant here would re-pose the very ambiguity the
          // storage change removed.
          fieldChanges: this.audit.diff(
            {
              name: existing.name,
              startDate: calendarDateOf(existing.startDate),
              endDate: calendarDateOf(existing.endDate),
            },
            {
              name: reloaded.name,
              startDate: calendarDateOf(reloaded.startDate),
              endDate: calendarDateOf(reloaded.endDate),
            },
          ),
        },
        transaction,
      );
      return reloaded;
    });

    const approvals = await this.latestApprovalsByCampaign([id]);
    return toCampaignDto(campaign, approvalContext(approvals.get(id)));
  }

  /**
   * `POST /campaigns/:id/merchants` — step 2 (TC-12/TC-13).
   *
   * Every id is checked through `ScopedRepository` against `Merchant`, whose strategy restricts a
   * maker to its own tenant. An id from another tenant therefore reads back as absent, and the
   * whole call fails with a 400 naming it — **before any row is written**, which is the half of
   * TC-13 that says *"no row written"*.
   */
  async setMerchants(
    actor: AuthenticatedUser,
    id: number,
    dto: SetCampaignMerchantsDto,
  ): Promise<readonly CampaignMerchantLink[]> {
    assertRole(actor, 'maker');

    return this.sequelize.transaction(async (transaction) => {
      const campaign = await this.loadEditableCampaign(id, transaction);
      const requested = [...new Set(dto.merchantIds)];

      const merchants =
        requested.length === 0
          ? []
          : await this.scoped.listAll(Merchant, {
              where: { id: { [Op.in]: requested } },
              transaction,
            });
      const found = new Set(merchants.map((merchant) => merchant.id));
      const missing = requested.filter((merchantId) => !found.has(merchantId));
      if (missing.length > 0) throw new MerchantNotInTenantError(missing);

      const existing = await this.scoped.listAll(CampaignMerchant, {
        where: { campaignId: id },
        transaction,
      });

      // Deactivate the ones that went away, (re)activate or insert the ones that stayed. A plain
      // delete-and-reinsert would trip `uq_cm_campaign_merchant` on the reinsert of a row the
      // delete had only soft-removed.
      for (const link of existing) {
        const wanted = found.has(link.merchantId);
        const status = wanted ? ROW_ACTIVE : ROW_INACTIVE;
        if (link.status !== status) {
          await this.scoped.update(
            CampaignMerchant,
            { status },
            { where: { id: link.id }, transaction },
          );
        }
      }
      const existingIds = new Set(existing.map((link) => link.merchantId));
      for (const merchantId of requested) {
        if (existingIds.has(merchantId)) continue;
        await this.scoped.create(
          CampaignMerchant,
          {
            tenantId: campaign.tenantId,
            campaignId: id,
            merchantId,
            status: ROW_ACTIVE,
          } as never,
          { transaction },
        );
      }

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: id,
          entityType: AUDIT_ENTITY.CAMPAIGN,
          entityId: id,
          action: AUDIT_ACTION.ASSIGNED,
          fieldChanges: { merchantIds: requested },
        },
        transaction,
      );

      return this.listMerchants(id, transaction);
    });
  }

  /** `GET /campaigns/:id/merchants`. */
  async listMerchants(
    campaignId: number,
    transaction?: Transaction,
  ): Promise<readonly CampaignMerchantLink[]> {
    const links = await this.scoped.listAll(CampaignMerchant, {
      where: { campaignId, status: ROW_ACTIVE },
      order: [['id', 'ASC']],
      transaction,
    });
    if (links.length === 0) return [];

    const merchants = await this.scoped.listAll(Merchant, {
      where: { id: { [Op.in]: links.map((link) => link.merchantId) } },
      transaction,
    });
    const byId = new Map(merchants.map((merchant) => [merchant.id, merchant]));

    return links
      .map((link) => {
        const merchant = byId.get(link.merchantId);
        return merchant === undefined
          ? null
          : toCampaignMerchantDto(link.id, merchant, link.status);
      })
      .filter((entry): entry is CampaignMerchantLink => entry !== null);
  }

  // --- the journey tree ----------------------------------------------------------------------

  /**
   * `GET /campaigns/:id/journey` — the tree steps 3 and 5 both render (04-FRONTEND.md §5.1/§5.5).
   *
   * Assembled from several scoped reads rather than one join, on purpose: every table involved
   * has its own scope strategy, and a hand-written join would be a second place where tenancy
   * could be got wrong. The queries are `IN`-batched per level, so the cost is a fixed handful of
   * round trips rather than one per node.
   */
  async getJourney(campaignId: number): Promise<Journey> {
    const [trackers, componentLinks, rewardAssignments] = await Promise.all([
      this.journey.trackersOfCampaign(campaignId),
      this.journey.componentLinks(campaignId),
      this.bindings.rewardAssignments(campaignId),
    ]);

    const componentsById = await this.journey.componentsById(
      componentLinks.map((link) => link.componentId),
    );
    const activities = await this.journey.activitiesById(
      [...componentsById.values()]
        .map((component) => component.activityId)
        .filter((id): id is number => id !== null),
    );

    const bindingsByComponent = await this.bindings.ruleBindingsByComponent(campaignId);
    const allBindings = [...bindingsByComponent.values()].flat();
    const describedRules = await this.bindings.describeBindings(allBindings);
    const describedRewards = await this.bindings.describeRewards(
      rewardAssignments.map((assignment) => assignment.rewardPolicyId),
      rewardAssignments
        .map((assignment) => assignment.rewardVersionId)
        .filter((id): id is number => id !== null),
    );

    const rewardDto = (assignment: (typeof rewardAssignments)[number]): RewardAssignment => {
      const entry = describedRewards.get(assignment.rewardPolicyId);
      return {
        id: assignment.id,
        level: assignment.level,
        refId: assignment.refId,
        rewardPolicyId: assignment.rewardPolicyId,
        rewardPolicyName: entry?.policy?.name ?? '',
        rewardId: entry?.policy?.rewardSystemId ?? 0,
        rewardName: entry?.system?.name ?? '',
        rewardVersionId: assignment.rewardVersionId,
        unitType: entry?.unitType ?? null,
        unitCode: entry?.unitCode ?? null,
        amount: entry?.amount ?? null,
        status: assignment.status,
      };
    };

    const journeyTrackers: JourneyTracker[] = trackers.map((tracker) => {
      const links = componentLinks.filter((link) => link.trackerId === tracker.id);
      const components: JourneyComponent[] = links
        .map((link): JourneyComponent | null => {
          const component = componentsById.get(link.componentId);
          if (component === undefined) return null;
          const bindings = bindingsByComponent.get(component.id) ?? [];
          return {
            id: component.id,
            linkId: link.id,
            componentCode: component.componentCode,
            name: component.name,
            description: component.description,
            activityId: component.activityId,
            activityName:
              component.activityId === null
                ? null
                : (activities.get(component.activityId)?.name ?? null),
            sequenceOrder: link.sequenceOrder,
            isMandatory: link.isMandatory,
            status: component.status,
            rules: bindings.map((binding) => {
              const described = describedRules.get(binding.id);
              return {
                id: binding.id,
                ruleId: binding.ruleId,
                ruleCode: described?.rule?.ruleCode ?? '',
                ruleName: described?.rule?.name ?? '',
                ruleVersionId: binding.ruleVersionId,
                ruleVersionNo: described?.version?.versionNo ?? null,
                parameters: described?.parameters ?? { fields: [] },
                values: binding.config,
                status: binding.status,
              };
            }),
            rewards: rewardAssignments
              .filter(
                (assignment) =>
                  assignment.level === 'component' && assignment.refId === component.id,
              )
              .map(rewardDto),
          };
        })
        .filter((component): component is JourneyComponent => component !== null);

      return {
        id: tracker.id,
        linkId: tracker.id,
        trackerCode: tracker.trackerCode,
        name: tracker.name,
        description: tracker.description,
        completionLogic: tracker.completionLogic as JourneyTracker['completionLogic'],
        completionThreshold: tracker.completionThreshold,
        isPrimary: false,
        status: tracker.status,
        components,
        rewards: rewardAssignments
          .filter((assignment) => assignment.level === 'tracker' && assignment.refId === tracker.id)
          .map(rewardDto),
      };
    });

    return {
      campaignId,
      trackers: journeyTrackers,
      campaignRewards: rewardAssignments
        .filter((assignment) => assignment.level === 'campaign')
        .map(rewardDto),
    };
  }

  // --- review and submit ---------------------------------------------------------------------

  /** `GET /campaigns/:id/review` — everything step 7 shows before the maker commits. */
  async review(id: number): Promise<CampaignReview> {
    const campaign = await this.loadCampaign(id);
    const [approvals, merchants, journey, caps, ceilings, rewards] = await Promise.all([
      this.latestApprovalsByCampaign([id]),
      this.listMerchants(id),
      this.getJourney(id),
      this.caps.activeCaps(id),
      this.caps.tenantCeilings(campaign.tenantId),
      this.bindings.rewardUnits(id),
    ]);

    const capsResponse = this.caps.buildResponse(campaign, caps, ceilings, rewards);
    const issues = validateStructure(await this.structureOf(id, journey, merchants.length));
    const overCeiling = capsResponse.ceilings.some((ceiling) => ceiling.state === 'over');

    return {
      campaign: toCampaignDto(campaign, approvalContext(approvals.get(id))),
      merchants: [...merchants],
      journey,
      caps: caps.map(toCampaignCapDto),
      warnings: capsResponse.warnings,
      ceilings: capsResponse.ceilings,
      worstCasePayout: [...worstCasePayout(rewards)],
      issues: [...issues],
      submittable: issues.length === 0 && !overCeiling,
    };
  }

  /**
   * `POST /campaigns/:id/submit` — implementation note 13, *"in one transaction: structural
   * validation, set `pending_approval`, create `approval_requests`, write audit, notify
   * checkers"*.
   *
   * Order inside the transaction is deliberate:
   *
   *  1. **Load and lock the campaign**, then assert the transition. Two submits racing must not
   *     both create an approval request.
   *  2. **Structural validation** (note 19) → 422 listing every problem (TC-21i/j/o).
   *  3. **Tenant ceiling** (note 17) → 422 `BUDGET_EXCEEDS_TENANT_CEILING` (TC-21ff, TC-21kk).
   *     After the structure check, because a campaign that cannot pay out at all is a more
   *     fundamental problem than one that would pay out too much.
   *  4. Status, approval request, audit — all three, or none.
   *
   * Notification is the one step **outside** the transaction, and deliberately: a notification
   * that fails must not roll back a valid submission, and `NotificationsService.notify` opens its
   * own write. The checker's queue is driven by `portal_approval_requests`, not by the
   * notification, so a lost notification costs a nudge rather than the workflow.
   */
  async submit(actor: AuthenticatedUser, id: number): Promise<SubmitCampaignResponse> {
    assertRole(actor, 'maker');

    const { campaign, requestId, expiresAt } = await this.sequelize.transaction(
      async (transaction) => {
        const existing = await this.loadCampaign(id, transaction);
        const nextStatus = assertTransition(existing.status, 'submit');

        const [journey, merchants, caps, ceilings, rewards] = await Promise.all([
          this.getJourney(id),
          this.listMerchants(id, transaction),
          this.caps.activeCaps(id, transaction),
          this.caps.tenantCeilings(existing.tenantId, transaction),
          this.bindings.rewardUnits(id, transaction),
        ]);

        const issues = validateStructure(await this.structureOf(id, journey, merchants.length));
        if (issues.length > 0) {
          throw new CampaignStructureIncompleteError(structuralIssueDetails(issues));
        }

        const capsResponse = this.caps.buildResponse(existing, caps, ceilings, rewards);
        const breaches = ceilingBreaches(capsResponse.ceilings);
        if (breaches.length > 0) throw new BudgetExceedsTenantCeilingError(breaches);

        await this.scoped.update(
          TenantCampaign,
          { status: nextStatus },
          { where: { id }, transaction },
        );

        const request = await this.scoped.create(
          PortalApprovalRequest,
          {
            tenantId: existing.tenantId,
            entityType: APPROVAL_ENTITY_CAMPAIGN,
            entityId: id,
            action: APPROVAL_ACTION_CREATE,
            status: APPROVAL_STATUS.PENDING,
            // Implementation note 18 — the payload carries the budget **as a percentage of the
            // ceiling**, so a checker sees an unusual number without doing arithmetic
            // (11-BUDGETS-AND-LIMITS.md §8.4, TC-21hh).
            payload: {
              campaignCode: existing.campaignCode,
              name: existing.name,
              // Calendar dates (T-065) — the checker's diff compares these against the campaign
              // as it stands now, and both sides must speak the same units.
              startDate: calendarDateOf(existing.startDate),
              endDate: calendarDateOf(existing.endDate),
              budgets: capsResponse.ceilings.map((ceiling) => ({
                unitType: ceiling.unitType,
                unitCode: ceiling.unitCode,
                campaignBudget: ceiling.campaignBudget,
                maxCampaignBudget: ceiling.maxCampaignBudget,
                percentOfCeiling: ceiling.percentOfCeiling,
                state: ceiling.state,
              })),
              warnings: capsResponse.warnings.map((warning) => warning.code),
              trackerCount: journey.trackers.length,
              componentCount: journey.trackers.reduce(
                (total, tracker) => total + tracker.components.length,
                0,
              ),
            },
            // gap G5 / implementation note 2 — an `int` column, so the id as a number. The FK is
            // to `reward_portal.portal_users(id)`, which is what makes this insertable at all;
            // see `T037_001_portal_approval_requests.ts`.
            requestedBy: actorRefId(actor),
            requestedAt: new Date(),
            reviewedBy: null,
            reviewedAt: null,
            reviewComment: null,
            expiresAt: expiryFrom(new Date()),
          } as never,
          { transaction },
        );

        // `recordOrFail`, not `record`: a campaign that reached `pending_approval` with no trace
        // of who submitted it is a governance failure, not an inconvenience. See
        // `campaign-audit.service.ts`'s header.
        await this.audit.recordOrFail(
          actor,
          {
            tenantId: existing.tenantId,
            campaignId: id,
            entityType: AUDIT_ENTITY.SUBMIT,
            entityId: id,
            action: AUDIT_ACTION.SUBMITTED,
            approvalRequestId: request.id,
            fieldChanges: { from: existing.status, to: nextStatus },
          },
          transaction,
        );

        const reloaded = await this.loadCampaign(id, transaction);
        return { campaign: reloaded, requestId: request.id, expiresAt: request.expiresAt };
      },
    );

    await this.notifyCheckers(campaign);

    return {
      campaign: toCampaignDto(campaign, {
        lastApprovalStatus: APPROVAL_STATUS.PENDING,
        lastReviewComment: null,
      }),
      approvalRequestId: requestId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // --- run-time state: pause and resume --------------------------------------------------------

  /**
   * `POST /campaigns/:id/pause` — 03-API-CONTRACT.md §11, `tenant_admin`.
   *
   * ### Why this arrived with T-047 rather than T-037
   *
   * §11 has always listed `pause`/`resume`, and `campaign-state-machine.ts` has always declared
   * both transitions, but no task's `Files owned` ever built the routes: T-037 stops at `submit`
   * and T-038 at the checker's three decisions. T-047 is where the gap stops being theoretical,
   * because implementation note 13 requires the budget-breach callback to call *"the **existing**
   * campaign-pause service method (the same one `POST /campaigns/:id/pause` uses), never a bespoke
   * status write"* — and a system the transaction runtime can pause but the tenant that owns it
   * cannot resume is worse than one with neither. Disclosed as an out-of-scope gap closure in the
   * T-047 completion report; `T047_003` grants the role §11 names.
   *
   * The state machine is the guard: `active → paused` only. A `draft` or `pending_approval`
   * campaign is a 409, not a silent no-op, because pausing something that was never running means
   * the caller believes something false.
   */
  async pause(actor: AuthenticatedUser, id: number): Promise<Campaign> {
    assertRole(actor, 'tenant_admin');
    return this.runTransition(actor, id, 'pause', AUDIT_ACTION.STATUS_CHANGED);
  }

  /** `POST /campaigns/:id/resume` — the mirror. `paused → active`. */
  async resume(actor: AuthenticatedUser, id: number): Promise<Campaign> {
    assertRole(actor, 'tenant_admin');
    return this.runTransition(actor, id, 'resume', AUDIT_ACTION.STATUS_CHANGED);
  }

  /**
   * The budget-breach pause (09-INTEGRATION.md §7a, T-047 TC-37…TC-40).
   *
   * Everything a `tenant_admin` pause does, and **nothing more** — it cannot create, edit or
   * approve anything, and it reaches the same `assertTransition`, the same scoped `UPDATE` and the
   * same change event. Three differences, each forced by the caller being a service rather than a
   * person:
   *
   *  1. **No `assertRole`.** There is no portal role to assert. Authorisation happened at the
   *     `grpc_service_grants` row before this method was reached (`budget-breach.controller.ts`),
   *     and `tenantId` here is the grant's, not the request body's.
   *  2. **`portal_audit_log`, not the campaign audit trail.** §7a fixes the shape:
   *     `event_type: budget_breach_paused`, `actor_role: 'system:transaction-runtime'`, `capId` and
   *     `observedTotal` in `detail`. `portal_campaign_audit_trail.performed_by` is a NOT NULL
   *     foreign key to `portal_users`, and the runtime is not one; inventing a user row for it
   *     would make the trail lie about who did this.
   *  3. **Idempotent** (TC-40). *"A campaign already `paused` receiving a second breach report for
   *     the same `capId` is a no-op, 200, not an error — the runtime may retry."* No second audit
   *     row, and no second change event.
   */
  async pauseFromRuntime(input: {
    readonly campaignId: number;
    readonly tenantId: number;
    readonly serviceIdentity: string;
    readonly capId: number;
    readonly observedTotal: string;
    readonly breachedAt: string;
  }): Promise<{
    readonly paused: boolean;
    readonly status: string;
    readonly campaignCode: string;
  }> {
    const outcome = await this.sequelize.transaction(async (transaction) => {
      const campaign = await this.loadCampaign(input.campaignId, transaction);
      if (campaign.status === CAMPAIGN_STATUS.PAUSED) {
        return { changed: false, campaign };
      }
      const nextStatus = assertTransition(campaign.status, 'pause');
      await this.scoped.update(
        TenantCampaign,
        { status: nextStatus },
        { where: { id: campaign.id }, transaction },
      );
      const reloaded = await this.loadCampaign(input.campaignId, transaction);
      return { changed: true, campaign: reloaded };
    });

    if (outcome.changed) {
      await this.portalAudit.recordPortalEvent({
        eventType: BREACH_AUDIT_EVENT,
        // No `actorId`: the column is nullable precisely so a non-user actor can be recorded
        // honestly. `actor_role` is what tells a human this was not a tenant_admin (§7a).
        actorId: null,
        actorRole: SYSTEM_ACTOR_ROLE,
        targetType: 'campaign',
        targetId: outcome.campaign.id,
        tenantId: outcome.campaign.tenantId,
        detail: {
          serviceIdentity: input.serviceIdentity,
          capId: input.capId,
          observedTotal: input.observedTotal,
          breachedAt: input.breachedAt,
          campaignCode: outcome.campaign.campaignCode,
        },
      });
      this.publishStatusChange(outcome.campaign);
    }

    return {
      paused: outcome.changed,
      status: outcome.campaign.status,
      campaignCode: outcome.campaign.campaignCode,
    };
  }

  /**
   * The one code path both human transitions take.
   *
   * Status change, campaign audit row and change event, in that order, with the event published
   * only after the transaction commits — an event announcing a state the database never reached
   * would send every runtime to refetch a config that had not changed.
   */
  private async runTransition(
    actor: AuthenticatedUser,
    id: number,
    transition: 'pause' | 'resume',
    action: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION],
  ): Promise<Campaign> {
    const campaign = await this.sequelize.transaction(async (transaction) => {
      const existing = await this.loadCampaign(id, transaction);
      const nextStatus = assertTransition(existing.status, transition);

      await this.scoped.update(
        TenantCampaign,
        { status: nextStatus },
        { where: { id }, transaction },
      );

      const reloaded = await this.loadCampaign(id, transaction);
      await this.audit.record(
        actor,
        {
          tenantId: reloaded.tenantId,
          campaignId: id,
          entityType: AUDIT_ENTITY.CAMPAIGN,
          entityId: id,
          action,
          fieldChanges: { from: existing.status, to: nextStatus },
        },
        transaction,
      );
      return reloaded;
    });

    this.publishStatusChange(campaign);

    const approvals = await this.latestApprovalsByCampaign([id]);
    return toCampaignDto(campaign, approvalContext(approvals.get(id)));
  }

  /**
   * Announces a committed status change to the runtime (§9).
   *
   * `paused` → `PAUSED`, `active` → `UPDATED` (a resumed campaign is a campaign the runtime should
   * start accruing against again), `completed`/`archived` → `ENDED`. Anything else publishes
   * nothing: a `draft` edit is not a governance event and must not reach the stream (TC-24).
   */
  private publishStatusChange(campaign: TenantCampaign): void {
    const changeType =
      campaign.status === CAMPAIGN_STATUS.PAUSED
        ? 'PAUSED'
        : campaign.status === CAMPAIGN_STATUS.ACTIVE
          ? 'UPDATED'
          : campaign.status === CAMPAIGN_STATUS.COMPLETED ||
              campaign.status === CAMPAIGN_STATUS.ARCHIVED
            ? 'ENDED'
            : null;
    if (changeType === null) return;

    this.changeEvents.publishTransition({
      campaignId: campaign.id,
      campaignCode: campaign.campaignCode,
      tenantId: campaign.tenantId,
      changeType,
    });
  }

  /** `GET /campaigns/:id/audit` (03-API-CONTRACT.md §11) — reads
   * `reward_portal.portal_campaign_audit_trail`; see `T037_002`'s header for why not the
   * `reward_config` table. */
  async listAudit(
    id: number,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  ): Promise<{ rows: CampaignAuditEntry[]; meta: ListMeta }> {
    await this.loadCampaign(id);
    const size = Math.min(pageSize, MAX_PAGE_SIZE);

    const rows = await this.scoped.listAll(PortalCampaignAuditTrail, {
      where: { campaignId: id },
      order: [
        ['performedAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: size,
      offset: (page - 1) * size,
    });
    const total = await this.scoped.count(PortalCampaignAuditTrail, { where: { campaignId: id } });

    const performerIds = [...new Set(rows.map((row) => row.performedBy))];
    const performers =
      performerIds.length === 0
        ? []
        : await this.scoped.listAll(PortalUser, {
            where: { id: { [Op.in]: performerIds } },
            attributes: ['id', 'displayName'],
          });
    const nameById = new Map(performers.map((user) => [user.id, user.displayName]));

    return {
      rows: rows.map((row) => toCampaignAuditDto(row, nameById.get(row.performedBy) ?? null)),
      meta: { page, pageSize: size, total },
    };
  }

  // --- private -------------------------------------------------------------------------------

  /** The journey reduced to the shape `validateStructure` needs. */
  private async structureOf(
    campaignId: number,
    journey: Journey,
    merchantCount: number,
  ): Promise<{
    trackers: TrackerShape[];
    components: ComponentShape[];
    merchantCount: number;
    rewardCount: number;
  }> {
    const components: ComponentShape[] = [];
    const trackers: TrackerShape[] = journey.trackers.map((tracker) => {
      for (const component of tracker.components) {
        components.push({
          id: component.id,
          activityId: component.activityId,
          rules: component.rules.map((rule) => ({
            parameters: rule.parameters,
            values: rule.values,
          })),
        });
      }
      return {
        id: tracker.id,
        completionLogic: tracker.completionLogic,
        completionThreshold: tracker.completionThreshold,
        componentIds: tracker.components.map((component) => component.id),
      };
    });

    const rewardCount =
      journey.campaignRewards.length +
      journey.trackers.reduce(
        (total, tracker) =>
          total +
          tracker.rewards.length +
          tracker.components.reduce((sum, component) => sum + component.rewards.length, 0),
        0,
      );

    // `campaignId` is unused by the reduction above but is kept in the signature: a future check
    // ("does every bound rule still resolve?") needs it, and threading it later would touch every
    // caller. Referenced here so the parameter is not merely decorative.
    void campaignId;

    return { trackers, components, merchantCount, rewardCount };
  }

  /**
   * The most recent approval request per campaign — what turns a stored `draft` into a presented
   * `returned` and what supplies the maker's "sent back with a comment" banner.
   */
  private async latestApprovalsByCampaign(
    campaignIds: readonly number[],
  ): Promise<Map<number, PortalApprovalRequest>> {
    const latest = new Map<number, PortalApprovalRequest>();
    if (campaignIds.length === 0) return latest;

    const rows = await this.scoped.listAll(PortalApprovalRequest, {
      where: {
        entityType: APPROVAL_ENTITY_CAMPAIGN,
        entityId: { [Op.in]: [...campaignIds] },
      },
      order: [
        ['requestedAt', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    for (const row of rows) {
      if (row.entityId === null || latest.has(row.entityId)) continue;
      latest.set(row.entityId, row);
    }
    return latest;
  }

  /**
   * Implementation note 13's *"notify checkers"*.
   *
   * Every `checker` in the campaign's own tenant. `PortalUser`'s scope strategy already restricts
   * a maker to its own tenant, so this cannot reach another tenant's checkers even though the
   * `where` clause does not mention a tenant. Capped at {@link MAX_CHECKERS_NOTIFIED} so a
   * misconfigured tenant fails visibly rather than turning one submit into an unbounded loop.
   */
  private async notifyCheckers(campaign: TenantCampaign): Promise<void> {
    const checkers = await this.scoped.listAll(PortalUser, {
      where: { role: 'checker', status: ROW_ACTIVE },
      attributes: ['id'],
      limit: MAX_CHECKERS_NOTIFIED,
    });

    for (const checker of checkers) {
      await this.notifications.notify({
        tenantId: campaign.tenantId,
        recipientPortalUserId: checker.id,
        notificationType: NOTIFICATION_TYPE.CAMPAIGN_SUBMITTED,
        title: 'Campaign submitted for approval',
        message: `"${campaign.name}" is waiting for your review.`,
        entityType: 'campaign',
        entityId: campaign.id,
        entityLabel: campaign.campaignCode,
      });
    }
  }
}

// --- module-private helpers ---------------------------------------------------------------------

function parseSort(sort: string | undefined): [string, 'asc' | 'desc'] {
  if (sort === undefined) return ['createdAt', 'desc'];
  const [field, direction] = sort.split(':') as [string, 'asc' | 'desc'];
  return [SORT_COLUMN[field] === undefined ? 'createdAt' : field, direction];
}

/** The whitelisted filters of `GET /campaigns` — explicit parameters only, never a query DSL
 * from the client (03-API-CONTRACT.md §1). */
function buildWhere(query: ListCampaignsQueryDto): WhereOptions | undefined {
  const clauses: WhereOptions[] = [];
  if (query.status !== undefined) clauses.push({ status: query.status } as WhereOptions);
  if (query.search !== undefined && query.search.trim() !== '') {
    const term = `%${query.search.trim()}%`;
    clauses.push({
      [Op.or]: [{ campaignCode: { [Op.iLike]: term } }, { name: { [Op.iLike]: term } }],
    } as WhereOptions);
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { [Op.and]: clauses } as WhereOptions;
}

function approvalContext(request: PortalApprovalRequest | undefined): {
  lastApprovalStatus: string | null;
  lastReviewComment: string | null;
} {
  if (request === undefined) return { lastApprovalStatus: null, lastReviewComment: null };
  return { lastApprovalStatus: request.status, lastReviewComment: request.reviewComment };
}

/** `approval_requests.expires_at` is `NOT NULL` and `approval_policies` carries no expiry column
 * — see `campaigns.constants.ts#APPROVAL_EXPIRY_DAYS` for why the horizon lives there. */
function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + APPROVAL_EXPIRY_DAYS * 86_400_000);
}
