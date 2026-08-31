/**
 * T-037 step 3 — the journey builder: trackers, components, sequence, mandatory flags and
 * completion logic (04-FRONTEND.md §5.3, implementation note 4: *"the journey structure is the
 * heart of this task"*).
 *
 * ### The two structural traps this file exists to close
 *
 * The task file names them itself: *"TC-21e and TC-21i are the two structural traps — an
 * unachievable threshold and a component with no completion rule both produce a campaign that
 * looks valid and can never pay out."* They are guarded in two different places, deliberately:
 *
 *  - **The threshold** is checked on *every write that could break it* — creating a tracker,
 *    editing its logic, and adding or removing a component ({@link assertThresholdAchievable}).
 *    It cannot wait for submit, because TC-21g is explicit that deleting a component must not
 *    silently leave a tracker unachievable.
 *  - **A component with no rule** is checked at **submit** only (`structural-validation.ts`,
 *    TC-21i expects 422 rather than 400). It has to be: a component is necessarily created
 *    before its rules are chosen, so rejecting it at write time would make the wizard unusable.
 *
 * That split is the general rule in this module — *"a draft may be anything; the gate is
 * submission"* — with the one exception of invariants that are cheaper to prevent than to
 * explain later.
 *
 * ### Incremental saves, and why nothing here is batched
 *
 * Implementation note 12: *"the journey tree is saved incrementally so a lost tab never costs a
 * built structure"*. Every method below is one user action, committed on its own. There is no
 * "save journey" call that could be lost.
 *
 * ### Deletion is a real DELETE for link rows and a status flip for entities
 *
 * `tracker_tracker_components` has no `status` and no `deleted_at` — it is a pure link table, and
 * a removed link is removed. The entities either side (`trackers`, `tracker_components`) are
 * flipped to `status='inactive'` instead, so the audit trail and any historical `campaign_caps`
 * row that referenced them still resolve. This mirrors what T-031/T-032 already do for
 * `rule_country_assignments` (deleted) versus `rule_master` (soft-deleted).
 */
import { Inject, Injectable } from '@nestjs/common';
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import {
  Activity,
  MerchantActivity,
  Tracker,
  TrackerComponent,
  TrackerTrackerComponent,
  TenantCampaign,
  TenantCampaignTracker,
  CampaignMerchant,
} from '@/database/models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { CampaignActivityOption } from '@reward-portal/shared';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  COMPONENT_CODE_PREFIX,
  ROW_ACTIVE,
  ROW_INACTIVE,
  TRACKER_CODE_PREFIX,
} from './campaigns.constants';
import {
  ActivityNotOfferedError,
  CodeGenerationFailedError,
  UnachievableThresholdError,
} from './campaigns.errors';
import { ATTEMPTS, buildCode } from './code-generator';
import { firstOrNull } from './scoped-lookup';
import { CampaignAuditService } from './campaign-audit.service';
import {
  assertComponentInCampaign,
  assertTrackerInCampaign,
  componentLinksOfCampaign,
  trackerIdsOfCampaign,
} from './campaign-membership';
import type {
  CreateComponentDto,
  CreateTrackerDto,
  ReorderComponentsDto,
  UpdateComponentDto,
  UpdateTrackerDto,
} from './dto/journey.dto';

@Injectable()
export class JourneyService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: CampaignAuditService,
  ) {}

  // --- trackers ------------------------------------------------------------------------------

  /** `POST /campaigns/:id/trackers`. Writes `trackers` **and** `tenant_campaign_trackers` in one
   * transaction — a tracker row with no campaign link is unreachable from every read path in
   * this module and would simply accumulate. */
  async createTracker(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    dto: CreateTrackerDto,
  ): Promise<Tracker> {
    assertRole(actor, 'maker');

    // A brand-new tracker has no components, so an `n_of` threshold cannot yet be satisfied by
    // any of them. Checking against zero here would reject every `n_of` tracker at birth, so the
    // check is deferred to the first component write and to submit — see
    // `assertThresholdAchievable`'s own comment.
    return this.sequelize.transaction(async (transaction) => {
      const tracker = await this.insertWithGeneratedCode(
        TRACKER_CODE_PREFIX,
        campaign.id,
        transaction,
        (code, savepoint) =>
          this.scoped.create(
            Tracker,
            {
              tenantId: campaign.tenantId,
              trackerCode: code,
              name: dto.name.trim(),
              description: dto.description ?? null,
              completionLogic: dto.completionLogic,
              completionThreshold: dto.completionThreshold ?? null,
              status: ROW_ACTIVE,
            } as never,
            { transaction: savepoint },
          ),
      );

      await this.scoped.create(
        TenantCampaignTracker,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          trackerId: tracker.id,
          isPrimary: dto.isPrimary ?? false,
          status: ROW_ACTIVE,
        } as never,
        { transaction },
      );

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.TRACKER,
          entityId: tracker.id,
          action: AUDIT_ACTION.CREATED,
          fieldChanges: {
            name: tracker.name,
            completionLogic: tracker.completionLogic,
            completionThreshold: tracker.completionThreshold,
          },
        },
        transaction,
      );

      return tracker;
    });
  }

  /** `PATCH /campaigns/:id/trackers/:trackerId` (TC-21d). */
  async updateTracker(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    trackerId: number,
    dto: UpdateTrackerDto,
  ): Promise<Tracker> {
    assertRole(actor, 'maker');

    return this.sequelize.transaction(async (transaction) => {
      const link = await assertTrackerInCampaign(this.scoped, campaign.id, trackerId, transaction);
      const tracker = await this.scoped.findByPkOrFail(Tracker, trackerId, { transaction });

      const changes: Record<string, unknown> = {};
      if (dto.name !== undefined) changes['name'] = dto.name.trim();
      if (dto.description !== undefined) changes['description'] = dto.description;
      if (dto.completionLogic !== undefined) changes['completionLogic'] = dto.completionLogic;
      if (dto.completionThreshold !== undefined) {
        changes['completionThreshold'] = dto.completionThreshold;
      }

      const logic = (changes['completionLogic'] as string | undefined) ?? tracker.completionLogic;
      const threshold =
        changes['completionThreshold'] !== undefined
          ? (changes['completionThreshold'] as number | null)
          : tracker.completionThreshold;

      // Switching away from `n_of` clears the threshold rather than leaving a stale number
      // behind: `ck_trk_logic` permits it, but a stored "2 of" on an `all` tracker is exactly the
      // sort of dormant value that confuses the next reader — and the runtime.
      if (logic !== 'n_of') changes['completionThreshold'] = null;
      else await this.assertThresholdAchievable(campaign.id, trackerId, threshold, transaction);

      if (Object.keys(changes).length > 0) {
        await this.scoped.update(Tracker, changes, { where: { id: trackerId }, transaction });
      }
      if (dto.isPrimary !== undefined) {
        await this.scoped.update(
          TenantCampaignTracker,
          { isPrimary: dto.isPrimary },
          { where: { id: link.id }, transaction },
        );
      }

      const reloaded = await this.scoped.findByPkOrFail(Tracker, trackerId, { transaction });
      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.TRACKER,
          entityId: trackerId,
          action: AUDIT_ACTION.UPDATED,
          fieldChanges: this.audit.diff(
            {
              name: tracker.name,
              completionLogic: tracker.completionLogic,
              completionThreshold: tracker.completionThreshold,
            },
            {
              name: reloaded.name,
              completionLogic: reloaded.completionLogic,
              completionThreshold: reloaded.completionThreshold,
            },
          ),
        },
        transaction,
      );
      return reloaded;
    });
  }

  /** `DELETE /campaigns/:id/trackers/:trackerId`. Removes the campaign link and every component
   * link, and deactivates the tracker — see this file's header on deletion semantics. */
  async removeTracker(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    trackerId: number,
  ): Promise<void> {
    assertRole(actor, 'maker');

    await this.sequelize.transaction(async (transaction) => {
      const link = await assertTrackerInCampaign(this.scoped, campaign.id, trackerId, transaction);

      await this.scoped.destroy(TrackerTrackerComponent, { where: { trackerId }, transaction });
      await this.scoped.update(
        TenantCampaignTracker,
        { status: ROW_INACTIVE },
        { where: { id: link.id }, transaction },
      );
      await this.scoped.update(
        Tracker,
        { status: ROW_INACTIVE },
        { where: { id: trackerId }, transaction },
      );

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.TRACKER,
          entityId: trackerId,
          action: AUDIT_ACTION.DELETED,
        },
        transaction,
      );
    });
  }

  // --- components ----------------------------------------------------------------------------

  /**
   * `POST /campaigns/:id/trackers/:trackerId/components` (TC-21a).
   *
   * Writes `tracker_components` **and** `tracker_tracker_components` together, with
   * `group_code = NULL` (implementation note 7c). The activity is checked against the campaign's
   * own step-2 merchants first — implementation note 8 / TC-21h, *"the client-side filter is
   * convenience only"*.
   */
  async createComponent(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    trackerId: number,
    dto: CreateComponentDto,
  ): Promise<{ component: TrackerComponent; link: TrackerTrackerComponent }> {
    assertRole(actor, 'maker');

    return this.sequelize.transaction(async (transaction) => {
      await assertTrackerInCampaign(this.scoped, campaign.id, trackerId, transaction);
      await this.assertActivityOffered(campaign.id, dto.activityId, transaction);

      const component = await this.insertWithGeneratedCode(
        COMPONENT_CODE_PREFIX,
        campaign.id,
        transaction,
        (code, savepoint) =>
          this.scoped.create(
            TrackerComponent,
            {
              tenantId: campaign.tenantId,
              componentCode: code,
              name: dto.name.trim(),
              description: dto.description ?? null,
              activityId: dto.activityId,
              completionCriteria: null,
              status: ROW_ACTIVE,
            } as never,
            { transaction: savepoint },
          ),
      );

      const sequenceOrder =
        dto.sequenceOrder ?? (await this.nextSequenceOrder(trackerId, transaction));

      const link = await this.scoped.create(
        TrackerTrackerComponent,
        {
          trackerId,
          componentId: component.id,
          sequenceOrder,
          isMandatory: dto.isMandatory ?? true,
          // Implementation note 7c / 12-CAMPAIGN-STRUCTURE.md §1.5 — grouping is deferred by
          // design and the wizard writes NULL throughout.
          groupCode: null,
        } as never,
        { transaction },
      );

      // Adding a component can only ever *raise* the count, so it cannot make a threshold
      // unachievable — but it can make a previously-impossible one satisfiable, and re-checking
      // here keeps the invariant true after every write rather than only after some of them.
      await this.assertThresholdAfterCountChange(campaign.id, trackerId, transaction);

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.COMPONENT,
          entityId: component.id,
          action: AUDIT_ACTION.CREATED,
          fieldChanges: {
            name: component.name,
            activityId: component.activityId,
            trackerId,
            sequenceOrder,
            isMandatory: link.isMandatory,
          },
        },
        transaction,
      );

      return { component, link };
    });
  }

  /** `PATCH /campaigns/:id/components/:componentId` (TC-21b/TC-21c/TC-21h). */
  async updateComponent(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    componentId: number,
    dto: UpdateComponentDto,
  ): Promise<TrackerComponent> {
    assertRole(actor, 'maker');

    return this.sequelize.transaction(async (transaction) => {
      const link = await assertComponentInCampaign(
        this.scoped,
        campaign.id,
        componentId,
        transaction,
      );
      // Scoped existence check: `assertComponentInCampaign` proves the *link* belongs to this
      // campaign, and this proves the component row itself is reachable in the actor's tenant.
      // Both are needed — a link row carries no tenant column of its own.
      const component = await this.scoped.findByPkOrFail(TrackerComponent, componentId, {
        transaction,
      });

      if (dto.activityId !== undefined) {
        await this.assertActivityOffered(campaign.id, dto.activityId, transaction);
      }

      const changes: Record<string, unknown> = {};
      if (dto.name !== undefined) changes['name'] = dto.name.trim();
      if (dto.description !== undefined) changes['description'] = dto.description;
      if (dto.activityId !== undefined) changes['activityId'] = dto.activityId;
      if (dto.ruleLogic !== undefined) changes['ruleLogic'] = dto.ruleLogic;
      if (dto.ruleThreshold !== undefined) changes['ruleThreshold'] = dto.ruleThreshold;

      /**
       * T-147, R7 review fix — `updateComponentRequestSchema`'s own refine only proves the
       * invariant ("n_of needs a threshold, anything else forbids one") for the fields present in
       * *this* request; it cannot see the component's existing row. A `PATCH { ruleThreshold: 5 }`
       * alone — `ruleLogic` omitted — passed that refine untouched and, before this fix, was
       * written straight through, silently persisting a threshold on a component whose stored
       * `ruleLogic` might not be `'n_of'`. Mirrors `updateTracker`'s own
       * `completionLogic`/`completionThreshold` merge one level up: compute the **effective**
       * post-update `ruleLogic`, and force-clear a stale threshold whenever it is not `'n_of'`,
       * rather than trusting the request to have sent both fields together.
       */
      const effectiveRuleLogic =
        (changes['ruleLogic'] as string | undefined) ?? component.ruleLogic;
      if (effectiveRuleLogic !== 'n_of') changes['ruleThreshold'] = null;

      if (Object.keys(changes).length > 0) {
        await this.scoped.update(TrackerComponent, changes, {
          where: { id: componentId },
          transaction,
        });
      }

      const linkChanges: Record<string, unknown> = {};
      if (dto.sequenceOrder !== undefined) linkChanges['sequenceOrder'] = dto.sequenceOrder;
      if (dto.isMandatory !== undefined) linkChanges['isMandatory'] = dto.isMandatory;
      if (Object.keys(linkChanges).length > 0) {
        await this.updateComponentLink(link.id, linkChanges, transaction);
      }

      const reloaded = await this.scoped.findByPkOrFail(TrackerComponent, componentId, {
        transaction,
      });
      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.COMPONENT,
          entityId: componentId,
          action: AUDIT_ACTION.UPDATED,
          fieldChanges: { ...changes, ...linkChanges },
        },
        transaction,
      );
      return reloaded;
    });
  }

  /**
   * `DELETE /campaigns/:id/components/:componentId` — **TC-21g**.
   *
   * *"Delete a component leaving threshold > count → 400 or auto-adjust with explicit warning;
   * never silently unachievable."* This implementation takes the **400** branch: the link is
   * removed inside a transaction, the resulting count is re-checked, and a threshold that no
   * longer fits rolls the whole thing back.
   *
   * Auto-adjusting was the alternative, and it is worse here. Silently changing "any 2 of 3" to
   * "any 2 of 2" — which is "all of 2" — changes what customers must do to be paid, as a side
   * effect of an unrelated edit. A maker who genuinely wants that can lower the threshold in one
   * click; a maker who did not want it would have no way to notice.
   */
  async removeComponent(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    componentId: number,
  ): Promise<void> {
    assertRole(actor, 'maker');

    await this.sequelize.transaction(async (transaction) => {
      const link = await assertComponentInCampaign(
        this.scoped,
        campaign.id,
        componentId,
        transaction,
      );

      await this.scoped.destroy(TrackerTrackerComponent, { where: { id: link.id }, transaction });
      await this.scoped.update(
        TrackerComponent,
        { status: ROW_INACTIVE },
        { where: { id: componentId }, transaction },
      );

      // The re-check that makes TC-21g hold. It runs *after* the delete, inside the transaction,
      // so it sees the post-delete count; throwing rolls the delete back.
      await this.assertThresholdAfterCountChange(campaign.id, link.trackerId, transaction);

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.COMPONENT,
          entityId: componentId,
          action: AUDIT_ACTION.DELETED,
          fieldChanges: { trackerId: link.trackerId },
        },
        transaction,
      );
    });
  }

  /** `PATCH /campaigns/:id/trackers/:trackerId/order` — TC-21b, the whole order in one call. */
  async reorderComponents(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    trackerId: number,
    dto: ReorderComponentsDto,
  ): Promise<void> {
    assertRole(actor, 'maker');

    await this.sequelize.transaction(async (transaction) => {
      await assertTrackerInCampaign(this.scoped, campaign.id, trackerId, transaction);

      for (const entry of dto.order) {
        const link = await firstOrNull(this.scoped, TrackerTrackerComponent, {
          where: { trackerId, componentId: entry.componentId },
          transaction,
        });
        // A component id that is not on this tracker is a 400 rather than a silent skip, for the
        // same reason an unassigned rule is: a reorder that quietly ignored half its payload
        // would leave the maker's screen and the database disagreeing.
        if (link === null) {
          await assertComponentInCampaign(this.scoped, campaign.id, entry.componentId, transaction);
        } else {
          await this.updateComponentLink(
            link.id,
            { sequenceOrder: entry.sequenceOrder },
            transaction,
          );
        }
      }

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.TRACKER,
          entityId: trackerId,
          action: AUDIT_ACTION.UPDATED,
          fieldChanges: { order: dto.order.map((entry) => entry.componentId) },
        },
        transaction,
      );
    });
  }

  // --- reads ---------------------------------------------------------------------------------

  /**
   * `GET /campaigns/:id/activities` — the activities a component may target (implementation
   * note 8).
   *
   * Derived from `campaign_merchants` → `merchant_activities` → `activities`, so it changes the
   * moment step 2 changes. A component whose activity is no longer offered is **not** rewritten
   * or removed here: the maker is shown the mismatch at submit instead, because silently editing
   * their journey because they deselected a merchant is a worse surprise than a validation error.
   */
  async listActivityOptions(campaignId: number): Promise<readonly CampaignActivityOption[]> {
    const merchantIds = await this.campaignMerchantIds(campaignId);
    if (merchantIds.length === 0) return [];

    const links = await this.scoped.listAll(MerchantActivity, {
      where: { merchantId: { [Op.in]: merchantIds }, status: ROW_ACTIVE },
      order: [['activityId', 'ASC']],
    });
    if (links.length === 0) return [];

    const activityIds = [...new Set(links.map((link) => link.activityId))];
    const activities = await this.scoped.listAll(Activity, {
      where: { id: { [Op.in]: activityIds }, status: ROW_ACTIVE },
      order: [['name', 'ASC']],
    });

    const merchantsByActivity = new Map<number, number[]>();
    for (const link of links) {
      const list = merchantsByActivity.get(link.activityId) ?? [];
      if (!list.includes(link.merchantId)) list.push(link.merchantId);
      merchantsByActivity.set(link.activityId, list);
    }

    return activities.map((activity) => ({
      activityId: activity.id,
      activityCode: activity.activityCode,
      name: activity.name,
      merchantIds: merchantsByActivity.get(activity.id) ?? [],
    }));
  }

  /** Every active component id of `campaignId`, with its link — the shape the journey tree, the
   * structural check and the reward tree all start from. */
  async componentLinks(
    campaignId: number,
    transaction?: Transaction,
  ): Promise<TrackerTrackerComponent[]> {
    return componentLinksOfCampaign(this.scoped, campaignId, transaction);
  }

  async trackersOfCampaign(campaignId: number, transaction?: Transaction): Promise<Tracker[]> {
    const trackerIds = await trackerIdsOfCampaign(this.scoped, campaignId, transaction);
    if (trackerIds.length === 0) return [];
    return this.scoped.listAll(Tracker, {
      where: { id: { [Op.in]: trackerIds } },
      order: [['id', 'ASC']],
      transaction,
    });
  }

  async componentsById(
    componentIds: readonly number[],
    transaction?: Transaction,
  ): Promise<Map<number, TrackerComponent>> {
    if (componentIds.length === 0) return new Map();
    const rows = await this.scoped.listAll(TrackerComponent, {
      where: { id: { [Op.in]: [...componentIds] } },
      transaction,
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  async activitiesById(
    activityIds: readonly number[],
    transaction?: Transaction,
  ): Promise<Map<number, Activity>> {
    const ids = activityIds.filter((id): id is number => id !== null);
    if (ids.length === 0) return new Map();
    const rows = await this.scoped.listAll(Activity, {
      where: { id: { [Op.in]: ids } },
      transaction,
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  // --- invariants ----------------------------------------------------------------------------

  /**
   * Implementation note 4 — `n_of` requires `1 <= threshold <= componentCount`
   * (TC-21e/TC-21f/TC-21g).
   *
   * `threshold < 1` is caught by the DTO too, but is re-checked here because this method is also
   * reached from `assertThresholdAfterCountChange`, where the value comes from the database
   * rather than from a request.
   *
   * **Zero components is exempt.** A tracker is necessarily created before its components, and a
   * freshly created `n_of` tracker would otherwise be rejected at birth for having a threshold
   * above a count of zero. The "no components at all" case is caught at submit instead (TC-21j,
   * 422) where it belongs — an empty tracker is an incomplete draft, not an invalid one.
   */
  private async assertThresholdAchievable(
    campaignId: number,
    trackerId: number,
    threshold: number | null,
    transaction?: Transaction,
  ): Promise<void> {
    const count = await this.componentCount(trackerId, transaction);
    if (count === 0) return;
    if (threshold === null || threshold < 1 || threshold > count) {
      throw new UnachievableThresholdError(threshold ?? 0, count);
    }
  }

  /** {@link assertThresholdAchievable} for the current stored logic/threshold — used after a
   * component is added or removed. A tracker that is not `n_of` has nothing to check. */
  private async assertThresholdAfterCountChange(
    campaignId: number,
    trackerId: number,
    transaction: Transaction,
  ): Promise<void> {
    const tracker = await this.scoped.findByPkOrFail(Tracker, trackerId, { transaction });
    if (tracker.completionLogic !== 'n_of') return;
    await this.assertThresholdAchievable(
      campaignId,
      trackerId,
      tracker.completionThreshold,
      transaction,
    );
  }

  /**
   * Implementation note 8 / TC-21h — *"a component's activity must be offered by a merchant
   * chosen in step 2. Validate against `merchant_activities` server-side."*
   *
   * A campaign with no merchants yet cannot offer any activity, so every component write fails
   * until step 2 is done. That ordering is what the wizard already imposes; enforcing it here
   * means a `curl` cannot skip it.
   */
  private async assertActivityOffered(
    campaignId: number,
    activityId: number,
    transaction?: Transaction,
  ): Promise<void> {
    const merchantIds = await this.campaignMerchantIds(campaignId, transaction);
    if (merchantIds.length === 0) throw new ActivityNotOfferedError(activityId);

    const offered = await this.scoped.count(MerchantActivity, {
      where: { merchantId: { [Op.in]: merchantIds }, activityId, status: ROW_ACTIVE },
      transaction,
    });
    if (offered === 0) throw new ActivityNotOfferedError(activityId);
  }

  // --- helpers -------------------------------------------------------------------------------

  /**
   * Updates one `tracker_tracker_components` row — the **only** write in this module that needs a
   * workaround, and the reason is worth stating precisely.
   *
   * ### What goes wrong without `bindParam: false`
   *
   * `TrackerTrackerComponent` has no tenant column of its own, so its scope strategy reaches it
   * through two `subquery` rules (`scope-strategy.ts`). `ScopedRepository` compiles those into a
   * `literal()` clause plus `replacements`. But Sequelize's `Model.update` builds its SET clause
   * with **`bind`** parameters, and `sequelize.query` refuses outright when both are present:
   *
   * > `Error: Both 'replacements' and 'bind' cannot be set at the same time`
   *
   * So `ScopedRepository.update` currently cannot write to *any* model whose applicable scope rule
   * is a subquery. This model is the first one in the codebase to hit that — every other table
   * this module writes carries a real `tenant_id` and compiles to a plain `column` rule for a
   * `maker`. Flagged in the T-037 completion report for `common/scope/**`'s owner (T-013), which
   * is outside this task's file scope to change (R9).
   *
   * ### Why `bindParam: false` is the right local fix and not a weakening
   *
   * It is a documented Sequelize option (`query-generator.js`: *"const bindParam =
   * options.bindParam === undefined ? this.bindParam(bind) : options.bindParam"*) that makes the
   * generator **escape** the SET values inline instead of binding them — the same escaping every
   * `where` value in this codebase already goes through. No value reaches the SQL unescaped, the
   * scope clause is unchanged and still applied, and the alternative (delete the link row and
   * insert a replacement) would churn primary keys and `created_at` on a table the audit trail
   * refers to.
   */
  private async updateComponentLink(
    linkId: number,
    changes: Record<string, unknown>,
    transaction: Transaction,
  ): Promise<void> {
    await this.scoped.update(TrackerTrackerComponent, changes, {
      where: { id: linkId },
      transaction,
      // Not on Sequelize's `UpdateOptions` type, but honoured at runtime — see this method's
      // own comment. Declared through a narrow intersection rather than `any` (R8).
      ...({ bindParam: false } as { bindParam: false }),
    });
  }

  private async campaignMerchantIds(
    campaignId: number,
    transaction?: Transaction,
  ): Promise<number[]> {
    const links = await this.scoped.listAll(CampaignMerchant, {
      where: { campaignId, status: ROW_ACTIVE },
      transaction,
    });
    return links.map((link) => link.merchantId);
  }

  private async componentCount(trackerId: number, transaction?: Transaction): Promise<number> {
    return this.scoped.count(TrackerTrackerComponent, { where: { trackerId }, transaction });
  }

  private async nextSequenceOrder(trackerId: number, transaction: Transaction): Promise<number> {
    const links = await this.scoped.listAll(TrackerTrackerComponent, {
      where: { trackerId },
      transaction,
    });
    return links.reduce((max, link) => Math.max(max, link.sequenceOrder), 0) + 1;
  }

  /**
   * Runs `insert` with a freshly generated code, retrying on the tenant-unique constraint.
   *
   * ### Each attempt runs inside its own SAVEPOINT, and that is load-bearing
   *
   * Postgres aborts the **whole transaction** on a constraint violation, not just the offending
   * statement: after a failed `INSERT`, every subsequent statement returns *"current transaction
   * is aborted, commands ignored until end of transaction block"*. So a naive `try { insert }
   * catch { insert again }` inside the caller's transaction would not retry — it would replace a
   * one-in-two-billion collision with a guaranteed failure of the entire operation, and it would
   * do so only on the code path nobody can reproduce.
   *
   * Passing `{ transaction: parent }` to `sequelize.transaction()` makes Sequelize open a
   * SAVEPOINT rather than a new transaction, and roll back **to that savepoint** when the
   * callback throws. The parent transaction survives, so the next attempt is a real attempt. The
   * retry loop is the whole reason codes are random rather than sequential — see
   * `code-generator.ts` for that argument.
   */
  private async insertWithGeneratedCode<T>(
    prefix: string,
    campaignId: number,
    parent: Transaction,
    insert: (code: string, transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        return await this.sequelize.transaction({ transaction: parent }, async (savepoint) =>
          insert(buildCode(prefix, campaignId), savepoint),
        );
      } catch (error) {
        if (!(error instanceof UniqueConstraintError)) throw error;
      }
    }
    throw new CodeGenerationFailedError(prefix);
  }
}
