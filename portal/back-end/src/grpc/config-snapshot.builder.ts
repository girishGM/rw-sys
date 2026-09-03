/**
 * T-047 — assembles the **complete, internally consistent** `CampaignConfig` (implementation
 * note 4, 09-INTEGRATION.md §10).
 *
 * > *"Never return a partial or best-effort config: the runtime's correct behaviour on a miss is
 * > to fail closed, and it can only do that if a response is either whole or an error."*
 *
 * Three rules govern everything below.
 *
 * ### 1. Build only what was asked for
 *
 * Implementation note 10 / §4c trap 2: *"Assembling the full config and then stripping it wastes
 * the database work that motivated sections in the first place."* Each `section*` method issues
 * its own queries and is called only when its section is in the resolved set, which is what TC-35
 * measures — the query count for `sections=[REWARDS]` is materially lower than for everything,
 * because the tracker, rule and cap queries are never issued at all.
 *
 * ### 2. A pin is honoured, never re-resolved
 *
 * TC-3 and TC-23 are the two tests that protect version pinning — *"the property the runtime's
 * whole audit trail depends on"*. `tracker_component_rules.rule_version_id` is written once when
 * the maker binds the rule and is never rewritten by a blast (06-VERSIONING.md §7), so it is read
 * and used verbatim here.
 *
 * The reward side has a genuine schema asymmetry that has to be handled rather than wished away:
 * only **campaign-level** reward assignments carry a `reward_version_id`; the tracker- and
 * component-level tables have no such column (see `reward-campaign-assignment.model.ts`). Resolving
 * those through the country's *current* version — which is what the wizard does when it offers a
 * reward to a maker — would mean a blast silently changed a live campaign's reward version, the
 * exact failure §9 exists to prevent. So they are resolved **as at the campaign's pin date**
 * (`definition_pinned_at`, else `approved_at`, else `start_date`): the newest version assigned to
 * the country *on or before* that date. A later blast has a later `assigned_at` and therefore
 * cannot change the answer, so the result is stable for the life of the campaign — deterministic
 * history rather than a moving target. Disclosed in the completion report as the closest available
 * reading of "every version pinned" given the columns that exist.
 *
 * ### 3. Missing data is an error, not a gap
 *
 * TC-26. A binding whose pinned `rule_version_id` names a row that is not there, or a reward
 * assignment whose policy has vanished, throws {@link IncompleteConfigError}. The one deliberate
 * exception is a binding with **no** pin at all (`rule_version_id IS NULL`), which the wizard
 * permits when a rule has no country-assigned version: that is not missing data, it is a campaign
 * that genuinely has no version to report, and refusing to serve it would take a live, portal-
 * approved campaign off the air. Such a rule is served with `version_no = 0` and logged at `warn`.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Op, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import {
  Activity,
  CampaignCap,
  CampaignMerchant,
  Merchant,
  MerchantActivity,
  RewardCampaignAssignment,
  RewardComponentAssignment,
  RewardPolicy,
  RewardSystem,
  RewardTrackerAssignment,
  RewardVersion,
  RewardVersionCountryAssignment,
  RuleMaster,
  RuleVersion,
  RuleVersionCountryAssignment,
  Tenant,
  TenantCampaign,
  TenantCampaignTracker,
  Tracker,
  TrackerComponent,
  TrackerComponentRule,
  TrackerTrackerComponent,
} from '@/database/models';
// T-171 — `reward_portal`, not `reward_config` (R1 forbids new DDL there); hence the second
// import rather than an addition to the barrel above.
import { ActivityExternalCode } from '@/database/portal-models';
import { calendarDateOf } from '@/modules/campaigns/campaign-date';
import { ROW_ACTIVE } from './grpc.constants';
import { IncompleteConfigError } from './grpc.errors';
import { runAsDefinitionReader } from './internal-read.scope';
import { includesSection, type SectionResolution } from './section-grant.guard';

// --- the shape this builder produces ------------------------------------------------------------
// Field names are the camelCase form of the proto field names (`proto-codec.ts#jsName`), so the
// payload is handed to the encoder unchanged. Volatile fields — `etag`, `configHash`, `servedAt`,
// `notModified` — are **not** here: they are computed by `campaign-config.service.ts` from this
// payload, and including them would make the hash depend on itself.

export interface MoneyPayload {
  readonly amount: string;
  readonly currency: string;
}

export interface ActivityPayload {
  readonly activityId: number;
  readonly activityCode: string;
  readonly name: string;
  /** T-171 — `reward_portal.activity_external_codes`, sorted, `[]` when none are configured. */
  readonly externalCodes: readonly string[];
}

export interface MerchantPayload {
  readonly merchantId: number;
  readonly merchantCode: string;
  readonly name: string;
  readonly status: string;
  readonly activities: readonly ActivityPayload[];
}

export interface ComponentPayload {
  readonly componentId: number;
  readonly componentCode: string;
  readonly name: string;
  readonly activityId: number;
  readonly sequenceOrder: number;
  readonly isMandatory: boolean;
  readonly status: string;
}

export interface TrackerPayload {
  readonly trackerId: number;
  readonly trackerCode: string;
  readonly name: string;
  readonly completionLogic: string;
  readonly completionThreshold: number;
  readonly status: string;
  readonly components: readonly ComponentPayload[];
}

export interface BoundRulePayload {
  readonly ruleId: number;
  readonly ruleVersionId: number;
  readonly versionNo: number;
  readonly ruleCode: string;
  readonly expression: string;
  readonly parametersJson: string;
  readonly boundValuesJson: string;
  readonly trackerComponentId: number;
  readonly status: string;
}

export interface BoundRewardPayload {
  readonly rewardId: number;
  readonly rewardVersionId: number;
  readonly versionNo: number;
  readonly systemCode: string;
  readonly rewardType: string;
  readonly deliveryMode: string;
  readonly policiesJson: string;
  readonly unitType: string;
  readonly unitCode: string;
  readonly level: string;
  readonly refId: number;
  readonly status: string;
}

export interface CampaignCapPayload {
  readonly capClass: string;
  readonly scopeLevel: string;
  readonly scopeRefId: number;
  readonly periodType: string;
  readonly periodValue: number;
  readonly windowStartTime: string;
  readonly windowEndTime: string;
  readonly periodTimezone: string;
  readonly unitType: string;
  readonly unitCode: string;
  readonly rewardType: string;
  readonly maxTotalAmount: string;
  readonly maxOccurrences: number;
  readonly maxCustomers: number;
  readonly onBreach: string;
  readonly warnAtPercent: number;
}

/** The non-volatile body of one `CampaignConfig`. */
export interface ConfigPayload {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly tenantId: number;
  readonly countryId: number;
  readonly status: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly budget?: MoneyPayload;
  readonly maxParticipants: number;
  readonly merchants: readonly MerchantPayload[];
  readonly trackers: readonly TrackerPayload[];
  readonly rules: readonly BoundRulePayload[];
  readonly rewards: readonly BoundRewardPayload[];
  readonly caps: readonly CampaignCapPayload[];
}

/** The cap rows a `GetBudgetStatus` response is built from, kept beside the cap section because
 * they are the same query with the row id retained. */
export interface CapWithId extends CampaignCapPayload {
  readonly capId: number;
}

@Injectable()
export class ConfigSnapshotBuilder {
  private readonly logger = new Logger(ConfigSnapshotBuilder.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
  ) {}

  /**
   * The campaign, or `null`.
   *
   * Looked up by `(tenant_id, campaign_code)` — the tenant comes from the grant, and the scope
   * clause `ScopedRepository` adds carries it too, so the two agree by construction. `status` is
   * **not** filtered here: the caller decides what an unservable status means, because
   * `GetCampaignConfig` and `ListActiveCampaigns` want different answers for a `paused` campaign.
   */
  async findCampaign(
    campaignCode: string,
    transaction: Transaction,
  ): Promise<TenantCampaign | null> {
    const rows = await this.scoped.listAll(TenantCampaign, {
      where: { campaignCode },
      limit: 1,
      transaction,
    });
    return rows[0] ?? null;
  }

  /** Every campaign of the tenant in `status`, oldest first. Used by `ListActiveCampaigns`. */
  async listCampaigns(status: string, transaction: Transaction): Promise<TenantCampaign[]> {
    return this.scoped.listAll(TenantCampaign, {
      where: { status },
      order: [['id', 'ASC']],
      transaction,
    });
  }

  /** The campaign's country, through its tenant. `country_id` is part of `BASIC`, and the
   * campaign row does not carry one. */
  async countryOf(campaign: TenantCampaign, transaction: Transaction): Promise<number> {
    const rows = await this.scoped.listAll(Tenant, {
      where: { id: campaign.tenantId },
      attributes: ['id', 'countryId'],
      limit: 1,
      transaction,
    });
    const tenant = rows[0];
    if (tenant === undefined) {
      // Unreachable through a foreign key that exists, which is exactly why it is an error rather
      // than a `0`: a campaign whose tenant cannot be read is not a campaign whose configuration
      // this service understands.
      throw new IncompleteConfigError(`tenant ${campaign.tenantId} could not be read`);
    }
    return tenant.countryId;
  }

  /**
   * Builds the requested sections of one campaign.
   *
   * Must be called inside {@link runReadOnly}'s transaction and inside the tenant scope — see
   * `internal-read.scope.ts`. `campaign` is already loaded so that the caller can decide about
   * status before paying for the rest.
   */
  async build(
    campaign: TenantCampaign,
    countryId: number,
    sections: SectionResolution,
    transaction: Transaction,
  ): Promise<ConfigPayload> {
    const wantsTrackers = includesSection(sections, 'TRACKERS');
    const wantsRules = includesSection(sections, 'RULES');
    const wantsRewards = includesSection(sections, 'REWARDS');

    // The tracker↔component links are needed by TRACKERS (structure), RULES (which components a
    // binding may hang off) and REWARDS (component-level attachments), so they are read once here
    // rather than three times — and not at all when none of the three was asked for.
    const links =
      wantsTrackers || wantsRules || wantsRewards
        ? await this.componentLinks(campaign.id, transaction)
        : { trackerIds: [] as number[], links: [] as TrackerTrackerComponent[] };

    const [merchants, trackers, rules, rewards, caps] = await Promise.all([
      includesSection(sections, 'MERCHANTS')
        ? this.sectionMerchants(campaign.id, transaction)
        : Promise.resolve([]),
      wantsTrackers ? this.sectionTrackers(links, transaction) : Promise.resolve([]),
      wantsRules ? this.sectionRules(links, countryId, campaign, transaction) : Promise.resolve([]),
      wantsRewards
        ? this.sectionRewards(campaign, countryId, links, transaction)
        : Promise.resolve([]),
      includesSection(sections, 'CAPS')
        ? this.sectionCaps(campaign.id, transaction)
        : Promise.resolve([]),
    ]);

    return {
      campaignId: campaign.id,
      campaignCode: campaign.campaignCode,
      tenantId: campaign.tenantId,
      countryId,
      status: campaign.status,
      startDate: campaignDate(campaign.startDate),
      endDate: campaignDate(campaign.endDate),
      ...(campaign.budgetAmount === null
        ? {}
        : {
            budget: {
              // Money crosses the wire as a string, never a float (§4b).
              amount: campaign.budgetAmount,
              currency: campaign.budgetCurrency ?? '',
            },
          }),
      maxParticipants: campaign.maxParticipants ?? 0,
      merchants,
      trackers,
      rules,
      rewards,
      caps: caps.map(stripCapId),
    };
  }

  // --- sections ---------------------------------------------------------------------------------

  /** MERCHANTS — participating merchants and the activities they offer. */
  private async sectionMerchants(
    campaignId: number,
    transaction: Transaction,
  ): Promise<readonly MerchantPayload[]> {
    const participation = await this.scoped.listAll(CampaignMerchant, {
      where: { campaignId, status: ROW_ACTIVE },
      order: [['id', 'ASC']],
      transaction,
    });
    if (participation.length === 0) return [];

    const merchantIds = participation.map((row) => row.merchantId);
    const [merchants, merchantActivities] = await Promise.all([
      this.scoped.listAll(Merchant, {
        where: { id: { [Op.in]: merchantIds } },
        order: [['id', 'ASC']],
        transaction,
      }),
      this.scoped.listAll(MerchantActivity, {
        where: { merchantId: { [Op.in]: merchantIds }, status: ROW_ACTIVE },
        order: [['id', 'ASC']],
        transaction,
      }),
    ]);

    const activityIds = [...new Set(merchantActivities.map((row) => row.activityId))];
    const [activities, externalCodes] =
      activityIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.scoped.listAll(Activity, {
              where: { id: { [Op.in]: activityIds } },
              transaction,
            }),
            // T-171 — the external/transaction-type codes each of those activities is also known
            // by. Ordered by the code itself so the payload — and therefore `config_hash` (§11:
            // "stable and comparable") — does not depend on physical row order.
            this.scoped.listAll(ActivityExternalCode, {
              where: { activityId: { [Op.in]: activityIds } },
              order: [['externalCode', 'ASC']],
              transaction,
            }),
          ]);
    const activityById = new Map(activities.map((row) => [row.id, row]));
    const externalCodesByActivity = new Map<number, string[]>();
    for (const row of externalCodes) {
      const existing = externalCodesByActivity.get(row.activityId);
      if (existing === undefined) externalCodesByActivity.set(row.activityId, [row.externalCode]);
      else existing.push(row.externalCode);
    }

    const byMerchant = new Map(merchants.map((row) => [row.id, row]));
    return participation
      .map((row): MerchantPayload | null => {
        const merchant = byMerchant.get(row.merchantId);
        if (merchant === undefined) {
          throw new IncompleteConfigError(
            `merchant ${row.merchantId} participates in this campaign but could not be read`,
          );
        }
        return {
          merchantId: merchant.id,
          merchantCode: merchant.merchantCode,
          name: merchant.name,
          status: merchant.status,
          activities: merchantActivities
            .filter((link) => link.merchantId === merchant.id)
            .map((link): ActivityPayload | null => {
              const activity = activityById.get(link.activityId);
              return activity === undefined
                ? null
                : {
                    activityId: activity.id,
                    activityCode: activity.activityCode,
                    name: activity.name,
                    // Always an array, never absent: an activity with no external code
                    // configured is the normal case, and a strict consumer must see an empty
                    // list rather than a missing key (T-171 TC-3).
                    externalCodes: externalCodesByActivity.get(activity.id) ?? [],
                  };
            })
            .filter((entry): entry is ActivityPayload => entry !== null),
        };
      })
      .filter((entry): entry is MerchantPayload => entry !== null);
  }

  /** TRACKERS — the tracker/component structure, sequence and completion logic. */
  private async sectionTrackers(
    links: ComponentLinks,
    transaction: Transaction,
  ): Promise<readonly TrackerPayload[]> {
    if (links.trackerIds.length === 0) return [];

    const [trackers, components] = await Promise.all([
      this.scoped.listAll(Tracker, {
        where: { id: { [Op.in]: links.trackerIds } },
        order: [['id', 'ASC']],
        transaction,
      }),
      links.links.length === 0
        ? Promise.resolve([] as TrackerComponent[])
        : this.scoped.listAll(TrackerComponent, {
            where: { id: { [Op.in]: links.links.map((link) => link.componentId) } },
            transaction,
          }),
    ]);
    const componentById = new Map(components.map((row) => [row.id, row]));

    return trackers.map((tracker) => ({
      trackerId: tracker.id,
      trackerCode: tracker.trackerCode,
      name: tracker.name,
      completionLogic: tracker.completionLogic,
      completionThreshold: tracker.completionThreshold ?? 0,
      status: tracker.status,
      components: links.links
        .filter((link) => link.trackerId === tracker.id)
        .map((link): ComponentPayload => {
          const component = componentById.get(link.componentId);
          if (component === undefined) {
            throw new IncompleteConfigError(
              `tracker component ${link.componentId} is linked to tracker ${tracker.id} but could not be read`,
            );
          }
          return {
            componentId: component.id,
            componentCode: component.componentCode,
            name: component.name,
            activityId: component.activityId ?? 0,
            sequenceOrder: link.sequenceOrder,
            isMandatory: link.isMandatory,
            status: component.status,
          };
        }),
    }));
  }

  /**
   * RULES — every bound rule, with **both** the version's parameter schema and the maker's values.
   *
   * Implementation note 5 / §4: *"Sending only values would force the runtime to trust our
   * validation; sending both lets it verify."* That is TC-2.
   */
  private async sectionRules(
    links: ComponentLinks,
    countryId: number,
    campaign: TenantCampaign,
    transaction: Transaction,
  ): Promise<readonly BoundRulePayload[]> {
    const componentIds = links.links.map((link) => link.componentId);
    if (componentIds.length === 0) return [];

    const bindings = await this.scoped.listAll(TrackerComponentRule, {
      where: { trackerComponentId: { [Op.in]: componentIds }, status: ROW_ACTIVE },
      order: [['id', 'ASC']],
      transaction,
    });
    if (bindings.length === 0) return [];

    const ruleIds = [...new Set(bindings.map((binding) => binding.ruleId))];
    const pinnedIds = [
      ...new Set(
        bindings.map((binding) => binding.ruleVersionId).filter((id): id is number => id !== null),
      ),
    ];
    const unpinnedRuleIds = [
      ...new Set(bindings.filter((binding) => binding.ruleVersionId === null).map((b) => b.ruleId)),
    ];

    // The five definition tables — see `internal-read.scope.ts` for why they are read under the
    // global scope and why the body of this call is kept to exactly that.
    const { rules, versions, historical } = await runAsDefinitionReader(async () => {
      const [ruleRows, versionRows, historicalRows] = await Promise.all([
        this.scoped.listAll(RuleMaster, {
          where: { id: { [Op.in]: ruleIds } },
          transaction,
        }),
        pinnedIds.length === 0
          ? Promise.resolve([] as RuleVersion[])
          : this.scoped.listAll(RuleVersion, {
              where: { id: { [Op.in]: pinnedIds } },
              transaction,
            }),
        this.historicalRuleVersions(unpinnedRuleIds, countryId, pinDateOf(campaign), transaction),
      ]);
      return { rules: ruleRows, versions: versionRows, historical: historicalRows };
    });

    const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
    const versionById = new Map(versions.map((version) => [version.id, version]));

    return bindings.map((binding): BoundRulePayload => {
      const rule = ruleById.get(binding.ruleId);
      if (rule === undefined) {
        throw new IncompleteConfigError(
          `rule ${binding.ruleId} is bound to component ${binding.trackerComponentId} but could not be read`,
        );
      }

      let version: RuleVersion | null = null;
      if (binding.ruleVersionId !== null) {
        version = versionById.get(binding.ruleVersionId) ?? null;
        if (version === null) {
          // TC-26. The pin names a row that is not there: the config cannot be built, and a
          // best-effort answer would be a runtime evaluating against the wrong definition.
          throw new IncompleteConfigError(
            `rule ${binding.ruleId} is pinned to rule_version ${binding.ruleVersionId}, which could not be read`,
          );
        }
      } else {
        version = historical.get(binding.ruleId) ?? null;
        if (version === null) {
          this.logger.warn(
            `campaign ${campaign.campaignCode}: rule ${binding.ruleId} is bound with no pinned ` +
              'version and no version was assigned to the country at the campaign pin date; ' +
              'serving version_no 0',
          );
        }
      }

      return {
        ruleId: rule.id,
        ruleVersionId: version?.id ?? 0,
        versionNo: version?.versionNo ?? 0,
        ruleCode: rule.ruleCode,
        expression: version?.expression ?? rule.expression ?? '',
        parametersJson: JSON.stringify(version?.parameters ?? rule.parameters ?? {}),
        boundValuesJson: JSON.stringify(binding.config ?? {}),
        trackerComponentId: binding.trackerComponentId,
        status: binding.status,
      };
    });
  }

  /** REWARDS — the three attachment levels, with units, and never `connector_config` (§6). */
  private async sectionRewards(
    campaign: TenantCampaign,
    countryId: number,
    links: ComponentLinks,
    transaction: Transaction,
  ): Promise<readonly BoundRewardPayload[]> {
    const componentIds = links.links.map((link) => link.componentId);

    const [campaignRows, trackerRows, componentRows] = await Promise.all([
      this.scoped.listAll(RewardCampaignAssignment, {
        where: { campaignId: campaign.id, status: ROW_ACTIVE },
        order: [['id', 'ASC']],
        transaction,
      }),
      links.trackerIds.length === 0
        ? Promise.resolve([] as RewardTrackerAssignment[])
        : this.scoped.listAll(RewardTrackerAssignment, {
            where: { trackerId: { [Op.in]: links.trackerIds }, status: ROW_ACTIVE },
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

    const attachments = [
      ...campaignRows.map((row) => ({
        level: 'campaign',
        refId: 0,
        policyId: row.rewardPolicyId,
        pinnedVersionId: row.rewardVersionId,
        status: row.status,
      })),
      ...trackerRows.map((row) => ({
        level: 'tracker',
        refId: row.trackerId,
        policyId: row.rewardPolicyId,
        pinnedVersionId: null as number | null,
        status: row.status,
      })),
      ...componentRows.map((row) => ({
        level: 'component',
        refId: row.componentId,
        policyId: row.rewardPolicyId,
        pinnedVersionId: null as number | null,
        status: row.status,
      })),
    ];
    if (attachments.length === 0) return [];

    const policyIds = [...new Set(attachments.map((entry) => entry.policyId))];
    const pinnedVersionIds = [
      ...new Set(
        attachments.map((entry) => entry.pinnedVersionId).filter((id): id is number => id !== null),
      ),
    ];

    const { policies, systems, pinned, historical } = await runAsDefinitionReader(async () => {
      const policyRows = await this.scoped.listAll(RewardPolicy, {
        where: { id: { [Op.in]: policyIds } },
        transaction,
      });
      const rewardIds = [...new Set(policyRows.map((policy) => policy.rewardSystemId))];
      const [systemRows, pinnedRows, historicalRows] = await Promise.all([
        rewardIds.length === 0
          ? Promise.resolve([] as RewardSystem[])
          : this.scoped.listAll(RewardSystem, {
              where: { id: { [Op.in]: rewardIds } },
              transaction,
            }),
        pinnedVersionIds.length === 0
          ? Promise.resolve([] as RewardVersion[])
          : this.scoped.listAll(RewardVersion, {
              where: { id: { [Op.in]: pinnedVersionIds } },
              transaction,
            }),
        this.historicalRewardVersions(rewardIds, countryId, pinDateOf(campaign), transaction),
      ]);
      return {
        policies: policyRows,
        systems: systemRows,
        pinned: pinnedRows,
        historical: historicalRows,
      };
    });

    const policyById = new Map(policies.map((policy) => [policy.id, policy]));
    const systemById = new Map(systems.map((system) => [system.id, system]));
    const pinnedById = new Map(pinned.map((version) => [version.id, version]));

    return attachments.map((entry): BoundRewardPayload => {
      const policy = policyById.get(entry.policyId);
      if (policy === undefined) {
        throw new IncompleteConfigError(
          `reward policy ${entry.policyId} is attached at ${entry.level} level but could not be read`,
        );
      }
      const system = systemById.get(policy.rewardSystemId);
      if (system === undefined) {
        throw new IncompleteConfigError(
          `reward system ${policy.rewardSystemId} could not be read for policy ${policy.id}`,
        );
      }

      let version: RewardVersion | null = null;
      if (entry.pinnedVersionId !== null) {
        version = pinnedById.get(entry.pinnedVersionId) ?? null;
        if (version === null) {
          throw new IncompleteConfigError(
            `reward ${system.id} is pinned to reward_version ${entry.pinnedVersionId}, which could not be read`,
          );
        }
      } else {
        version = historical.get(system.id) ?? null;
      }

      return {
        rewardId: system.id,
        rewardVersionId: version?.id ?? 0,
        versionNo: version?.versionNo ?? 0,
        systemCode: system.systemCode,
        rewardType: system.rewardType,
        deliveryMode: version?.deliveryMode ?? system.deliveryMode,
        // The version's frozen policy snapshot, or the policy row's own config. Never
        // `connector_config` — §6, and `reward_systems` does not even expose it on this model.
        policiesJson: JSON.stringify(version?.policiesSnapshot ?? policy.config ?? {}),
        unitType: version?.unitType ?? '',
        unitCode: version?.unitCode ?? '',
        level: entry.level,
        refId: entry.refId,
        status: entry.status,
      };
    });
  }

  /** CAPS — budgets and customer limits (11-BUDGETS-AND-LIMITS.md §5). */
  async sectionCaps(campaignId: number, transaction: Transaction): Promise<readonly CapWithId[]> {
    const caps = await this.scoped.listAll(CampaignCap, {
      where: { campaignId, status: ROW_ACTIVE },
      order: [['id', 'ASC']],
      transaction,
    });
    return caps.map((cap) => ({
      capId: cap.id,
      capClass: cap.capClass,
      scopeLevel: cap.scopeLevel,
      scopeRefId: cap.scopeRefId ?? 0,
      periodType: cap.periodType,
      periodValue: cap.periodValue ?? 0,
      windowStartTime: cap.windowStartTime ?? '',
      windowEndTime: cap.windowEndTime ?? '',
      periodTimezone: cap.periodTimezone ?? '',
      unitType: cap.unitType ?? '',
      unitCode: cap.unitCode ?? '',
      rewardType: cap.rewardType ?? '',
      // Money as a string, never a float (§4b).
      maxTotalAmount: cap.maxTotalAmount ?? '',
      maxOccurrences: cap.maxOccurrences ?? 0,
      maxCustomers: cap.maxCustomers ?? 0,
      onBreach: cap.onBreach,
      warnAtPercent: cap.warnAtPercent ?? 0,
    }));
  }

  // --- private ----------------------------------------------------------------------------------

  /** The campaign's trackers and their component links, in one place. */
  private async componentLinks(
    campaignId: number,
    transaction: Transaction,
  ): Promise<ComponentLinks> {
    const trackerLinks = await this.scoped.listAll(TenantCampaignTracker, {
      where: { campaignId, status: ROW_ACTIVE },
      order: [['id', 'ASC']],
      transaction,
    });
    const trackerIds = trackerLinks.map((link) => link.trackerId);
    if (trackerIds.length === 0) return { trackerIds: [], links: [] };

    const links = await this.scoped.listAll(TrackerTrackerComponent, {
      where: { trackerId: { [Op.in]: trackerIds } },
      order: [
        ['trackerId', 'ASC'],
        ['sequenceOrder', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
    return { trackerIds, links };
  }

  /**
   * The newest rule version assigned to `countryId` **on or before** `pinDate`, per rule.
   *
   * Only used for bindings that carry no pin of their own. `assigned_at <= pinDate` is what makes
   * a later blast unable to change the answer — see this file's header.
   */
  private async historicalRuleVersions(
    ruleIds: readonly number[],
    countryId: number,
    pinDate: Date,
    transaction: Transaction,
  ): Promise<Map<number, RuleVersion>> {
    const byRule = new Map<number, RuleVersion>();
    if (ruleIds.length === 0) return byRule;

    const assignments = await this.scoped.listAll(RuleVersionCountryAssignment, {
      where: {
        ruleId: { [Op.in]: [...ruleIds] },
        countryId,
        status: ROW_ACTIVE,
        assignedAt: { [Op.lte]: pinDate },
      },
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
      if (byRule.has(assignment.ruleId)) continue;
      const version = versionById.get(assignment.ruleVersionId);
      if (version !== undefined) byRule.set(assignment.ruleId, version);
    }
    return byRule;
  }

  /** The reward mirror of {@link historicalRuleVersions}. */
  private async historicalRewardVersions(
    rewardIds: readonly number[],
    countryId: number,
    pinDate: Date,
    transaction: Transaction,
  ): Promise<Map<number, RewardVersion>> {
    const byReward = new Map<number, RewardVersion>();
    if (rewardIds.length === 0) return byReward;

    const assignments = await this.scoped.listAll(RewardVersionCountryAssignment, {
      where: {
        rewardId: { [Op.in]: [...rewardIds] },
        countryId,
        status: ROW_ACTIVE,
        assignedAt: { [Op.lte]: pinDate },
      },
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
}

interface ComponentLinks {
  readonly trackerIds: readonly number[];
  readonly links: readonly TrackerTrackerComponent[];
}

/**
 * The instant a campaign's definitions were fixed.
 *
 * `definition_pinned_at` is the column 06-VERSIONING.md added for exactly this; `approved_at` is
 * the governance event that made the campaign real; `start_date` is the last resort for legacy
 * rows written by the `create-campaign` agents, which predate both. Never `now()` — a pin date
 * that moves is not a pin.
 */
function pinDateOf(campaign: TenantCampaign): Date {
  return campaign.definitionPinnedAt ?? campaign.approvedAt ?? campaign.startDate;
}

/**
 * A campaign's start/end for the wire: RFC3339 at UTC midnight of the calendar date it is
 * (T-065, `campaign_config.v1.proto`'s own field comments).
 *
 * Normalised rather than passed through `toISOString()`, so a row written before T-065 — one
 * still carrying a `23:59:59` end-of-day time in whichever offset its maker's browser used — is
 * served as the *day* it names and not as the stray instant it was stored as. The alternative
 * would leak the defect this fix removes into the one contract an external system consumes and
 * cannot renegotiate.
 *
 * Both bounds are **inclusive**; a consumer that reads `end_date` as an expiry instant clips the
 * campaign's last day. That is stated in the `.proto` because it cannot be inferred from the
 * value.
 */
function campaignDate(value: Date): string {
  const day = calendarDateOf(value instanceof Date ? value : new Date(value));
  return `${day}T00:00:00.000Z`;
}

/**
 * Drop the row id from a cap before it crosses the wire. `CampaignCap` in the proto has no
 * `cap_id` field (09-INTEGRATION.md §3) — only `BudgetStatusEntry` does — so the id is retained
 * on the query result and removed here rather than queried twice. Written as an explicit
 * projection rather than a rest-destructure so no field can be added to `CapWithId` and reach the
 * config payload by accident.
 */
function stripCapId(cap: CapWithId): CampaignCapPayload {
  return {
    capClass: cap.capClass,
    scopeLevel: cap.scopeLevel,
    scopeRefId: cap.scopeRefId,
    periodType: cap.periodType,
    periodValue: cap.periodValue,
    windowStartTime: cap.windowStartTime,
    windowEndTime: cap.windowEndTime,
    periodTimezone: cap.periodTimezone,
    unitType: cap.unitType,
    unitCode: cap.unitCode,
    rewardType: cap.rewardType,
    maxTotalAmount: cap.maxTotalAmount,
    maxOccurrences: cap.maxOccurrences,
    maxCustomers: cap.maxCustomers,
    onBreach: cap.onBreach,
    warnAtPercent: cap.warnAtPercent,
  };
}
