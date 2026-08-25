/**
 * T-037 steps 4 and 5 — binding rules to components with their dynamic values, and attaching
 * rewards at the three levels.
 *
 * ### The product rule this file is built around
 *
 * > *"Rules bind to a tracker component, never to the campaign. Selection is restricted to
 * > versions assigned to the actor's country via `ruleVisibilityScope()` (T-031). A rule id
 * > outside that set → 400, **never** a silent skip that yields a campaign missing a rule the
 * > maker believed they added."* (implementation note 7; TC-15 and Verification step 5.)
 *
 * `ruleVisibilityScope()` is not a function anywhere in this codebase, and deliberately so:
 * `scope-strategy.ts`'s `RuleMaster` entry **is** that helper, and says so in its own comment
 * (*"T-031's `ruleVisibilityScope(countryId)` helper must be built on this entry rather than
 * beside it"*). `RulesService`'s header records the same conclusion at length. So the country
 * gate here is a plain scoped read of `RuleMaster` by id (`scoped-lookup.ts#byIdOrNull`, which is
 * `ScopedRepository.listAll` under a name the R2 lint rule permits) — which compiles
 * `id IN (SELECT rule_id FROM rule_country_assignments WHERE country_id = :actorCountry)` for
 * every non-super-admin role — and a `null` result becomes the 400. There is no second copy of
 * that subquery in this module, which is the entire point.
 *
 * ### Why a `null` from a scoped read becomes a 400 and not the usual 404
 *
 * `findByPkOrFail` would throw `ScopeViolationError` → 404, which is right for tenant data and
 * wrong here. See `campaigns.errors.ts`'s header for the full argument; the short version is
 * that global rules are Super-Admin-authored configuration whose ids leak nothing, and that the
 * task file demands 400 twice, because the failure being guarded is *a maker shipping a campaign
 * that silently lost a rule*.
 *
 * ### Server-side re-validation is the control; the client's copy is a convenience
 *
 * Implementation note 9. {@link bindRule} loads the pinned version's own `parameters`, builds the
 * value schema with the **shared** `buildRuleValueSchema` — literally the same function
 * `DynamicParameterForm` builds its resolver from — and parses. A `curl` that skips the SPA
 * meets exactly the same schema (TC-17, TC-18, TC-19, Verification step 6).
 */
import { Inject, Injectable } from '@nestjs/common';
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import {
  RewardCampaignAssignment,
  RewardComponentAssignment,
  RewardPolicy,
  RewardSystem,
  RewardTrackerAssignment,
  RewardVersion,
  RewardVersionCountryAssignment,
  RuleCategory,
  RuleMaster,
  RuleSubCategory,
  RuleVersion,
  RuleVersionCountryAssignment,
  TenantCampaign,
  TrackerComponentRule,
} from '@/database/models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import { ValidationFailedError } from '@/common/errors/app-error';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import {
  buildRuleValueSchema,
  ruleParametersSchema,
  type RewardOption,
  type RewardLevel,
  type RuleOption,
  type RuleParameters,
} from '@reward-portal/shared';
import { AUDIT_ACTION, AUDIT_ENTITY, ROW_ACTIVE, ROW_INACTIVE } from './campaigns.constants';
import {
  RewardAlreadyAttachedError,
  RewardNotAssignedToCountryError,
  RuleAlreadyBoundError,
  RuleNotAssignedToCountryError,
} from './campaigns.errors';
import { CampaignAuditService } from './campaign-audit.service';
import {
  assertComponentInCampaign,
  assertTrackerInCampaign,
  componentLinksOfCampaign,
  trackerIdsOfCampaign,
} from './campaign-membership';
import type { RewardUnit } from './budget-analysis';
import { byIdOrNull } from './scoped-lookup';
import type {
  AttachRewardDto,
  BindComponentRuleDto,
  UpdateComponentRuleValuesDto,
} from './dto/binding.dto';

/** A rule and the version pinned for the actor's country, resolved together. */
interface ResolvedRule {
  readonly rule: RuleMaster;
  readonly version: RuleVersion | null;
  readonly parameters: RuleParameters;
}

@Injectable()
export class BindingsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: CampaignAuditService,
  ) {}

  // --- rules ---------------------------------------------------------------------------------

  /**
   * `GET /campaigns/:id/rule-options` — the step-3 rule picker (TC-14: *"only rules assigned to
   * X"*).
   *
   * The country gate is `ScopedRepository`'s, not a clause written here. A `super_admin` calling
   * this sees every rule, which is correct and harmless: they cannot create a campaign at all
   * (`assertRole(actor, 'maker')` on every write).
   */
  async listRuleOptions(): Promise<readonly RuleOption[]> {
    const rules = await this.scoped.listAll(RuleMaster, {
      where: { status: ROW_ACTIVE },
      order: [['name', 'ASC']],
    });
    if (rules.length === 0) return [];

    const [subCategories, categories, versionsByRule] = await Promise.all([
      this.scoped.listAll(RuleSubCategory, {
        where: { id: { [Op.in]: [...new Set(rules.map((rule) => rule.subCategoryId))] } },
      }),
      this.scoped.listAll(RuleCategory, {}),
      this.activeRuleVersionsByRule(rules.map((rule) => rule.id)),
    ]);

    const subCategoryById = new Map(subCategories.map((row) => [row.id, row]));
    const categoryById = new Map(categories.map((row) => [row.id, row]));

    return rules.map((rule) => {
      const subCategory = subCategoryById.get(rule.subCategoryId);
      const category =
        subCategory === undefined ? undefined : categoryById.get(subCategory.categoryId);
      const version = versionsByRule.get(rule.id) ?? null;
      return {
        ruleId: rule.id,
        ruleCode: rule.ruleCode,
        name: rule.name,
        categoryName: category?.name ?? null,
        subCategoryName: subCategory?.name ?? null,
        ruleVersionId: version?.id ?? null,
        ruleVersionNo: version?.versionNo ?? null,
        parameters: parametersOf(version?.parameters ?? rule.parameters),
      };
    });
  }

  /**
   * `POST /campaigns/:id/rules` — bind a rule to a component and supply its values (TC-16).
   *
   * Order matters and is not incidental: membership (TC-21q) → country visibility (TC-15) →
   * value validation (TC-17/18/19) → duplicate check → insert. Each step refuses with the error
   * the task file names for it, and no later step can be reached by failing an earlier one.
   */
  async bindRule(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    dto: BindComponentRuleDto,
  ): Promise<TrackerComponentRule> {
    assertRole(actor, 'maker');

    return this.sequelize.transaction(async (transaction) => {
      await assertComponentInCampaign(this.scoped, campaign.id, dto.componentId, transaction);

      const resolved = await this.resolveRule(dto.ruleId, transaction);
      const values = validateRuleValues(resolved.parameters, dto.values ?? {});

      const existing = await this.scoped.count(TrackerComponentRule, {
        where: {
          trackerComponentId: dto.componentId,
          ruleId: dto.ruleId,
          status: ROW_ACTIVE,
        },
        transaction,
      });
      if (existing > 0) throw new RuleAlreadyBoundError();

      const binding = await this.scoped.create(
        TrackerComponentRule,
        {
          tenantId: campaign.tenantId,
          trackerComponentId: dto.componentId,
          ruleId: dto.ruleId,
          config: values,
          status: ROW_ACTIVE,
          // 06-VERSIONING.md §7 — the binding pin, written once and never rewritten by a blast.
          ruleVersionId: resolved.version?.id ?? null,
        } as never,
        { transaction },
      );

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.RULE_ASSIGNMENT,
          entityId: binding.id,
          action: AUDIT_ACTION.ASSIGNED,
          fieldChanges: {
            componentId: dto.componentId,
            ruleId: dto.ruleId,
            ruleVersionId: resolved.version?.id ?? null,
            values,
          },
        },
        transaction,
      );

      return binding;
    });
  }

  /** `PATCH /campaigns/:id/rules/:bindingId` — step 4 edits values in place, re-validating
   * against the **pinned** version rather than whatever is current (06-VERSIONING.md §7). */
  async updateRuleValues(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    bindingId: number,
    dto: UpdateComponentRuleValuesDto,
  ): Promise<TrackerComponentRule> {
    assertRole(actor, 'maker');

    return this.sequelize.transaction(async (transaction) => {
      const binding = await this.loadBinding(campaign.id, bindingId, transaction);
      const parameters = await this.parametersForBinding(binding, transaction);
      const values = validateRuleValues(parameters, dto.values);

      await this.scoped.update(
        TrackerComponentRule,
        { config: values },
        { where: { id: bindingId }, transaction },
      );

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.RULE_ASSIGNMENT,
          entityId: bindingId,
          action: AUDIT_ACTION.UPDATED,
          fieldChanges: this.audit.diff(binding.config, values),
        },
        transaction,
      );

      return this.scoped.findByPkOrFail(TrackerComponentRule, bindingId, { transaction });
    });
  }

  /** `DELETE /campaigns/:id/rules/:bindingId`. Soft — `status='inactive'` — so the audit trail's
   * `entityId` still resolves to a readable row. */
  async unbindRule(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    bindingId: number,
  ): Promise<void> {
    assertRole(actor, 'maker');

    await this.sequelize.transaction(async (transaction) => {
      const binding = await this.loadBinding(campaign.id, bindingId, transaction);
      await this.scoped.update(
        TrackerComponentRule,
        { status: ROW_INACTIVE },
        { where: { id: bindingId }, transaction },
      );
      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.RULE_ASSIGNMENT,
          entityId: bindingId,
          action: AUDIT_ACTION.UNASSIGNED,
          fieldChanges: { componentId: binding.trackerComponentId, ruleId: binding.ruleId },
        },
        transaction,
      );
    });
  }

  /** Every active rule binding of `campaignId`, keyed by component id. */
  async ruleBindingsByComponent(
    campaignId: number,
    transaction?: Transaction,
  ): Promise<Map<number, TrackerComponentRule[]>> {
    const links = await componentLinksOfCampaign(this.scoped, campaignId, transaction);
    const componentIds = links.map((link) => link.componentId);
    const byComponent = new Map<number, TrackerComponentRule[]>();
    if (componentIds.length === 0) return byComponent;

    const bindings = await this.scoped.listAll(TrackerComponentRule, {
      where: { trackerComponentId: { [Op.in]: componentIds }, status: ROW_ACTIVE },
      order: [['id', 'ASC']],
      transaction,
    });
    for (const binding of bindings) {
      const list = byComponent.get(binding.trackerComponentId) ?? [];
      list.push(binding);
      byComponent.set(binding.trackerComponentId, list);
    }
    return byComponent;
  }

  /** The rule + parameter metadata every binding in `bindings` needs, resolved in two queries
   * rather than two per binding. */
  async describeBindings(
    bindings: readonly TrackerComponentRule[],
    transaction?: Transaction,
  ): Promise<
    Map<
      number,
      { rule: RuleMaster | null; version: RuleVersion | null; parameters: RuleParameters }
    >
  > {
    const described = new Map<
      number,
      { rule: RuleMaster | null; version: RuleVersion | null; parameters: RuleParameters }
    >();
    if (bindings.length === 0) return described;

    const ruleIds = [...new Set(bindings.map((binding) => binding.ruleId))];
    const versionIds = bindings
      .map((binding) => binding.ruleVersionId)
      .filter((id): id is number => id !== null);

    const [rules, versions] = await Promise.all([
      this.scoped.listAll(RuleMaster, { where: { id: { [Op.in]: ruleIds } }, transaction }),
      versionIds.length === 0
        ? Promise.resolve([] as RuleVersion[])
        : this.scoped.listAll(RuleVersion, {
            where: { id: { [Op.in]: versionIds } },
            transaction,
          }),
    ]);

    const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
    const versionById = new Map(versions.map((version) => [version.id, version]));

    for (const binding of bindings) {
      const rule = ruleById.get(binding.ruleId) ?? null;
      const version =
        binding.ruleVersionId === null ? null : (versionById.get(binding.ruleVersionId) ?? null);
      described.set(binding.id, {
        rule,
        version,
        parameters: parametersOf(version?.parameters ?? rule?.parameters ?? {}),
      });
    }
    return described;
  }

  // --- rewards -------------------------------------------------------------------------------

  /**
   * `GET /campaigns/:id/reward-options` — the step-5 reward picker (TC-21: *"only rewards
   * assigned to X"*).
   *
   * The country gate is again `ScopedRepository`'s: `RewardPolicy`'s strategy is
   * `rewardSystemId IN (SELECT reward_id FROM reward_country_assignments WHERE country_id = …)`,
   * the exact mirror of the rule side.
   *
   * `unitType`/`unitCode` come from the reward **version** assigned to the country
   * (11-BUDGETS-AND-LIMITS.md §3.1: *"the unit lives on the reward version"*), which is what step
   * 6's "your points reward has no budget" warning matches on.
   */
  async listRewardOptions(): Promise<readonly RewardOption[]> {
    const policies = await this.scoped.listAll(RewardPolicy, {
      where: { status: ROW_ACTIVE },
      order: [['name', 'ASC']],
    });
    if (policies.length === 0) return [];

    const rewardIds = [...new Set(policies.map((policy) => policy.rewardSystemId))];
    const [systems, versionsByReward] = await Promise.all([
      this.scoped.listAll(RewardSystem, { where: { id: { [Op.in]: rewardIds } } }),
      this.activeRewardVersionsByReward(rewardIds),
    ]);
    const systemById = new Map(systems.map((system) => [system.id, system]));

    return policies.map((policy) => {
      const system = systemById.get(policy.rewardSystemId);
      const version = versionsByReward.get(policy.rewardSystemId) ?? null;
      return {
        rewardPolicyId: policy.id,
        policyCode: policy.policyCode,
        policyName: policy.name,
        rewardId: policy.rewardSystemId,
        rewardName: system?.name ?? '',
        rewardType: system?.rewardType ?? null,
        rewardVersionId: version?.id ?? null,
        unitType: version?.unitType ?? null,
        unitCode: version?.unitCode ?? null,
        amount: readPolicyAmount(policy),
      };
    });
  }

  /** `POST /campaigns/:id/rewards` — TC-21k/l/m/n. */
  async attachReward(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    dto: AttachRewardDto,
  ): Promise<number> {
    assertRole(actor, 'maker');

    return this.sequelize.transaction(async (transaction) => {
      const policy = await this.resolveRewardPolicy(dto.rewardPolicyId, transaction);

      if (dto.level === 'tracker') {
        await assertTrackerInCampaign(this.scoped, campaign.id, dto.refId ?? 0, transaction);
      } else if (dto.level === 'component') {
        await assertComponentInCampaign(this.scoped, campaign.id, dto.refId ?? 0, transaction);
      }

      const id = await this.insertRewardAssignment(campaign, dto, policy.id, transaction);

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.REWARD_ASSIGNMENT,
          entityId: id,
          action: AUDIT_ACTION.ASSIGNED,
          fieldChanges: {
            level: dto.level,
            refId: dto.refId ?? null,
            rewardPolicyId: policy.id,
          },
        },
        transaction,
      );

      return id;
    });
  }

  /** `DELETE /campaigns/:id/rewards/:level/:assignmentId`. Soft, for the same reason rule
   * unbinding is. */
  async detachReward(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    level: RewardLevel,
    assignmentId: number,
  ): Promise<void> {
    assertRole(actor, 'maker');

    await this.sequelize.transaction(async (transaction) => {
      if (level === 'campaign') {
        await this.scoped.findOneOrFail(RewardCampaignAssignment, {
          where: { id: assignmentId, campaignId: campaign.id },
          transaction,
        });
        await this.scoped.update(
          RewardCampaignAssignment,
          { status: ROW_INACTIVE },
          { where: { id: assignmentId }, transaction },
        );
      } else if (level === 'tracker') {
        const row = await this.scoped.findByPkOrFail(RewardTrackerAssignment, assignmentId, {
          transaction,
        });
        await assertTrackerInCampaign(this.scoped, campaign.id, row.trackerId, transaction);
        await this.scoped.update(
          RewardTrackerAssignment,
          { status: ROW_INACTIVE },
          { where: { id: assignmentId }, transaction },
        );
      } else {
        const row = await this.scoped.findByPkOrFail(RewardComponentAssignment, assignmentId, {
          transaction,
        });
        await assertComponentInCampaign(this.scoped, campaign.id, row.componentId, transaction);
        await this.scoped.update(
          RewardComponentAssignment,
          { status: ROW_INACTIVE },
          { where: { id: assignmentId }, transaction },
        );
      }

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.REWARD_ASSIGNMENT,
          entityId: assignmentId,
          action: AUDIT_ACTION.UNASSIGNED,
          fieldChanges: { level },
        },
        transaction,
      );
    });
  }

  /**
   * Every reward attachment of `campaignId`, across all three levels, resolved to the shape the
   * worst-case payout and the "no budget for this unit" warning both need.
   *
   * One method rather than three because every caller wants all three levels — implementation
   * note 10's whole point is that *"three reward levels may all be populated at once"*, so
   * reasoning about them separately is exactly the mistake the step-5 tree exists to prevent.
   */
  async rewardAssignments(
    campaignId: number,
    transaction?: Transaction,
  ): Promise<
    readonly {
      id: number;
      level: RewardLevel;
      refId: number | null;
      rewardPolicyId: number;
      rewardVersionId: number | null;
      status: string;
    }[]
  > {
    const [trackerIds, componentLinks] = await Promise.all([
      trackerIdsOfCampaign(this.scoped, campaignId, transaction),
      componentLinksOfCampaign(this.scoped, campaignId, transaction),
    ]);
    const componentIds = componentLinks.map((link) => link.componentId);

    const [campaignRows, trackerRows, componentRows] = await Promise.all([
      this.scoped.listAll(RewardCampaignAssignment, {
        where: { campaignId, status: ROW_ACTIVE },
        order: [['id', 'ASC']],
        transaction,
      }),
      trackerIds.length === 0
        ? Promise.resolve([] as RewardTrackerAssignment[])
        : this.scoped.listAll(RewardTrackerAssignment, {
            where: { trackerId: { [Op.in]: trackerIds }, status: ROW_ACTIVE },
            order: [['id', 'ASC']],
            transaction,
          }),
      componentIds.length === 0
        ? Promise.resolve([] as RewardComponentAssignment[])
        : this.scoped.listAll(RewardComponentAssignment, {
            where: { componentId: { [Op.in]: componentIds }, status: ROW_ACTIVE },
            order: [['id', 'ASC']],
            transaction,
          }),
    ]);

    return [
      ...campaignRows.map((row) => ({
        id: row.id,
        level: 'campaign' as const,
        refId: null,
        rewardPolicyId: row.rewardPolicyId,
        rewardVersionId: row.rewardVersionId,
        status: row.status,
      })),
      ...trackerRows.map((row) => ({
        id: row.id,
        level: 'tracker' as const,
        refId: row.trackerId,
        rewardPolicyId: row.rewardPolicyId,
        rewardVersionId: null,
        status: row.status,
      })),
      ...componentRows.map((row) => ({
        id: row.id,
        level: 'component' as const,
        refId: row.componentId,
        rewardPolicyId: row.rewardPolicyId,
        rewardVersionId: null,
        status: row.status,
      })),
    ];
  }

  /**
   * The reward metadata every attachment needs — policy, reward system, unit and amount.
   *
   * The unit comes from the version pinned on the assignment when there is one (campaign level
   * only — see `reward-campaign-assignment.model.ts` on that asymmetry) and otherwise from the
   * version currently assigned to the actor's country. That fallback is why a tracker-level
   * points reward still matches a PTS budget in step 6.
   */
  async describeRewards(
    policyIds: readonly number[],
    pinnedVersionIds: readonly number[],
    transaction?: Transaction,
  ): Promise<
    Map<
      number,
      {
        policy: RewardPolicy | null;
        system: RewardSystem | null;
        unitType: string | null;
        unitCode: string | null;
        amount: string | null;
      }
    >
  > {
    const result = new Map<
      number,
      {
        policy: RewardPolicy | null;
        system: RewardSystem | null;
        unitType: string | null;
        unitCode: string | null;
        amount: string | null;
      }
    >();
    if (policyIds.length === 0) return result;

    const policies = await this.scoped.listAll(RewardPolicy, {
      where: { id: { [Op.in]: [...new Set(policyIds)] } },
      transaction,
    });
    const rewardIds = [...new Set(policies.map((policy) => policy.rewardSystemId))];
    const [systems, versionsByReward, pinnedVersions] = await Promise.all([
      rewardIds.length === 0
        ? Promise.resolve([] as RewardSystem[])
        : this.scoped.listAll(RewardSystem, { where: { id: { [Op.in]: rewardIds } }, transaction }),
      this.activeRewardVersionsByReward(rewardIds, transaction),
      pinnedVersionIds.length === 0
        ? Promise.resolve([] as RewardVersion[])
        : this.scoped.listAll(RewardVersion, {
            where: { id: { [Op.in]: [...new Set(pinnedVersionIds)] } },
            transaction,
          }),
    ]);

    const systemById = new Map(systems.map((system) => [system.id, system]));
    const pinnedById = new Map(pinnedVersions.map((version) => [version.id, version]));

    for (const policy of policies) {
      const version = versionsByReward.get(policy.rewardSystemId) ?? null;
      result.set(policy.id, {
        policy,
        system: systemById.get(policy.rewardSystemId) ?? null,
        unitType: version?.unitType ?? null,
        unitCode: version?.unitCode ?? null,
        amount: readPolicyAmount(policy),
      });
    }
    // A pinned version overrides the country-current one for the units it declares.
    for (const version of pinnedById.values()) {
      for (const [policyId, entry] of result.entries()) {
        if (entry.policy?.rewardSystemId !== version.rewardId) continue;
        result.set(policyId, {
          ...entry,
          unitType: version.unitType ?? entry.unitType,
          unitCode: version.unitCode ?? entry.unitCode,
        });
      }
    }
    return result;
  }

  /** The reward units of `campaignId` — the input to step 6's unbudgeted-reward warning and to
   * the worst-case payout line. */
  async rewardUnits(campaignId: number, transaction?: Transaction): Promise<readonly RewardUnit[]> {
    const assignments = await this.rewardAssignments(campaignId, transaction);
    if (assignments.length === 0) return [];
    const described = await this.describeRewards(
      assignments.map((assignment) => assignment.rewardPolicyId),
      assignments
        .map((assignment) => assignment.rewardVersionId)
        .filter((id): id is number => id !== null),
      transaction,
    );
    return assignments.map((assignment) => {
      const entry = described.get(assignment.rewardPolicyId);
      return {
        unitType: entry?.unitType ?? null,
        unitCode: entry?.unitCode ?? null,
        amount: entry?.amount ?? null,
      };
    });
  }

  // --- private -------------------------------------------------------------------------------

  /** The country gate (TC-15). See this file's header for why a `null` becomes a 400. */
  private async resolveRule(ruleId: number, transaction: Transaction): Promise<ResolvedRule> {
    const rule = await byIdOrNull(this.scoped, RuleMaster, ruleId, { transaction });
    if (rule === null || rule.status !== ROW_ACTIVE) {
      throw new RuleNotAssignedToCountryError(ruleId);
    }
    const versions = await this.activeRuleVersionsByRule([ruleId], transaction);
    const version = versions.get(ruleId) ?? null;
    return { rule, version, parameters: parametersOf(version?.parameters ?? rule.parameters) };
  }

  /** The reward mirror of {@link resolveRule} (TC-21). */
  private async resolveRewardPolicy(
    rewardPolicyId: number,
    transaction: Transaction,
  ): Promise<RewardPolicy> {
    const policy = await byIdOrNull(this.scoped, RewardPolicy, rewardPolicyId, { transaction });
    if (policy === null || policy.status !== ROW_ACTIVE) {
      throw new RewardNotAssignedToCountryError(rewardPolicyId);
    }
    return policy;
  }

  private async loadBinding(
    campaignId: number,
    bindingId: number,
    transaction: Transaction,
  ): Promise<TrackerComponentRule> {
    const binding = await this.scoped.findByPkOrFail(TrackerComponentRule, bindingId, {
      transaction,
    });
    await assertComponentInCampaign(
      this.scoped,
      campaignId,
      binding.trackerComponentId,
      transaction,
    );
    return binding;
  }

  private async parametersForBinding(
    binding: TrackerComponentRule,
    transaction: Transaction,
  ): Promise<RuleParameters> {
    if (binding.ruleVersionId !== null) {
      const version = await byIdOrNull(this.scoped, RuleVersion, binding.ruleVersionId, {
        transaction,
      });
      if (version !== null) return parametersOf(version.parameters);
    }
    const rule = await byIdOrNull(this.scoped, RuleMaster, binding.ruleId, { transaction });
    return parametersOf(rule?.parameters ?? {});
  }

  /**
   * The rule version currently assigned to the actor's country, per rule.
   *
   * `RuleVersionCountryAssignment`'s scope strategy is `countryId = <actor's country>`, so this
   * needs no country parameter — the actor's own country is already in the compiled clause. That
   * is the same "computed once, in the one place T-013 already proved correct" discipline the
   * rule picker follows.
   */
  private async activeRuleVersionsByRule(
    ruleIds: readonly number[],
    transaction?: Transaction,
  ): Promise<Map<number, RuleVersion>> {
    const byRule = new Map<number, RuleVersion>();
    if (ruleIds.length === 0) return byRule;

    const assignments = await this.scoped.listAll(RuleVersionCountryAssignment, {
      where: { ruleId: { [Op.in]: [...ruleIds] }, status: ROW_ACTIVE },
      order: [['assignedAt', 'DESC']],
      transaction,
    });
    if (assignments.length === 0) return byRule;

    const versions = await this.scoped.listAll(RuleVersion, {
      where: { id: { [Op.in]: assignments.map((row) => row.ruleVersionId) } },
      transaction,
    });
    const versionById = new Map(versions.map((version) => [version.id, version]));

    for (const assignment of assignments) {
      // `assignedAt DESC` means the first assignment seen for a rule is its most recent, which is
      // the one a new binding pins. A country may legitimately hold two versions at once
      // (06-VERSIONING.md §5.1) — the newest is the one the wizard offers.
      if (byRule.has(assignment.ruleId)) continue;
      const version = versionById.get(assignment.ruleVersionId);
      if (version !== undefined) byRule.set(assignment.ruleId, version);
    }
    return byRule;
  }

  /** The reward mirror of {@link activeRuleVersionsByRule}. */
  private async activeRewardVersionsByReward(
    rewardIds: readonly number[],
    transaction?: Transaction,
  ): Promise<Map<number, RewardVersion>> {
    const byReward = new Map<number, RewardVersion>();
    if (rewardIds.length === 0) return byReward;

    const assignments = await this.scoped.listAll(RewardVersionCountryAssignment, {
      where: { rewardId: { [Op.in]: [...rewardIds] }, status: ROW_ACTIVE },
      order: [['assignedAt', 'DESC']],
      transaction,
    });
    if (assignments.length === 0) return byReward;

    const versions = await this.scoped.listAll(RewardVersion, {
      where: { id: { [Op.in]: assignments.map((row) => row.rewardVersionId) } },
      transaction,
    });
    const versionById = new Map(versions.map((version) => [version.id, version]));

    for (const assignment of assignments) {
      if (byReward.has(assignment.rewardId)) continue;
      const version = versionById.get(assignment.rewardVersionId);
      if (version !== undefined) byReward.set(assignment.rewardId, version);
    }
    return byReward;
  }

  /** The three insert shapes, kept together so the `uq_*` → 409 mapping is written once. */
  private async insertRewardAssignment(
    campaign: TenantCampaign,
    dto: AttachRewardDto,
    policyId: number,
    transaction: Transaction,
  ): Promise<number> {
    try {
      if (dto.level === 'campaign') {
        const row = await this.scoped.create(
          RewardCampaignAssignment,
          {
            tenantId: campaign.tenantId,
            rewardPolicyId: policyId,
            campaignId: campaign.id,
            assignedAt: new Date(),
            status: ROW_ACTIVE,
            rewardVersionId: null,
          } as never,
          { transaction },
        );
        return row.id;
      }
      if (dto.level === 'tracker') {
        const row = await this.scoped.create(
          RewardTrackerAssignment,
          {
            tenantId: campaign.tenantId,
            rewardPolicyId: policyId,
            trackerId: dto.refId,
            assignedAt: new Date(),
            status: ROW_ACTIVE,
          } as never,
          { transaction },
        );
        return row.id;
      }
      const row = await this.scoped.create(
        RewardComponentAssignment,
        {
          tenantId: campaign.tenantId,
          rewardPolicyId: policyId,
          componentId: dto.refId,
          assignedAt: new Date(),
          status: ROW_ACTIVE,
        } as never,
        { transaction },
      );
      return row.id;
    } catch (error) {
      if (error instanceof UniqueConstraintError)
        throw new RewardAlreadyAttachedError({ cause: error });
      throw error;
    }
  }
}

// --- module-private helpers ---------------------------------------------------------------------

/**
 * A `parameters` blob from the database, coerced to the shared meta-schema.
 *
 * Rows written before `ruleParametersSchema` existed — or by the live `create-campaign` agents,
 * which predate this portal entirely — may not match it. Falling back to "no fields" is the
 * fail-safe direction: the maker is asked for nothing rather than shown a broken form, and the
 * value schema built from it accepts an empty object and rejects any key, which is exactly right
 * for a rule that declares no parameters.
 */
function parametersOf(raw: unknown): RuleParameters {
  const parsed = ruleParametersSchema.safeParse(raw);
  return parsed.success ? parsed.data : { fields: [] };
}

/**
 * The maker's supplied values, validated against the rule's own meta-schema (implementation
 * note 9).
 *
 * The failures this produces are TC-17 (a value below `min`), TC-18 (a missing required key) and
 * TC-19 (a key the schema does not declare, rejected by `.strict()`), and every one of them is a
 * 400 carrying a `details` entry naming the offending key. `ValidationFailedError` is used rather
 * than a bespoke error so these arrive in the same envelope as every other validation failure in
 * the system.
 *
 * The `field` in each detail is the parameter key prefixed with `values.`, which
 * `SAFE_FIELD_PATTERN` permits (it allows dots) and which lets the SPA map the error straight
 * back onto the generated form control.
 */
function validateRuleValues(
  parameters: RuleParameters,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const schema = buildRuleValueSchema(parameters);
  const parsed = schema.safeParse(values);
  if (parsed.success) return parsed.data;

  throw new ValidationFailedError(
    parsed.error.issues.map((issue) => ({
      field: `values.${issue.path.join('.') || 'root'}`,
      code: issueCode(issue.code),
    })),
    { logMessage: 'rule parameter values failed server-side validation' },
  );
}

/** Zod's issue code, mapped into `SAFE_ERROR_CODE_PATTERN`'s upper-snake shape. */
function issueCode(code: string): string {
  const upper = code.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,59}$/.test(upper) ? upper : 'INVALID_VALUE';
}

/**
 * The per-grant amount a reward policy pays, when its `config` exposes one.
 *
 * `reward_policies.config` is free-form `text` holding JSON that this portal does not own the
 * shape of (T-032 stores whatever the connector needs). Three key names cover every policy shape
 * seen so far; anything else yields `null`, which the worst-case payout reports honestly as
 * `hasUnknownAmounts` rather than silently treating as zero. Guessing a number here would be
 * worse than admitting ignorance: a payout line that is confidently wrong is the one a maker
 * would act on.
 */
function readPolicyAmount(policy: RewardPolicy): string | null {
  const config = policy.config;
  if (config === null || typeof config !== 'object') return null;
  const record = config as Record<string, unknown>;
  for (const key of ['amount', 'value', 'points']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && /^\d{1,14}(\.\d{1,4})?$/.test(candidate)) return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return candidate.toFixed(4).replace(/\.?0+$/, '');
    }
  }
  return null;
}
