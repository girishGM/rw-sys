/**
 * T-003 — barrel of every `reward_config`-schema Sequelize model this task set out to
 * cover, plus the three already built by T-006 (`CampaignCap`, `TenantBudgetCeiling`) and
 * T-007 (`TrackerGroupDef`), which this file wires into the shared connection for the
 * first time (they had no owning Nest/Sequelize module until `database.module.ts`
 * existed), and the seven T-005 versioning/blast/definition-request tables
 * (`RuleVersion`, `RewardVersion`, `RuleVersionCountryAssignment`,
 * `RewardVersionCountryAssignment`, `VersionBlast`, `VersionBlastTarget`,
 * `DefinitionRequest`) — added beyond the task file's own fixed "reward_config models
 * required" list per 05-EXECUTION-PLAN.md §1: "T-003 ... models every table those
 * migrations create" (T-002/T-005/T-006/T-007 all named explicitly). Consumed by
 * `sequelize.provider.ts` and the schema-drift test.
 */
export * from './country.model';
export * from './tenant.model';
export * from './merchant.model';
export * from './merchant-store.model';
export * from './merchant-activity.model';
export * from './activity.model';
export * from './activity-type.model';
export * from './activity-category.model';
export * from './role-nav-config.model';
export * from './role-entity-permission.model';
export * from './role-dashboard-widget.model';
export * from './rbac-cache-config.model';
export * from './system-message.model';
export * from './rule-master.model';
export * from './rule-category.model';
export * from './rule-sub-category.model';
export * from './rule-country-assignment.model';
export * from './reward-system.model';
export * from './reward-policy.model';
export * from './reward-country-assignment.model';
export * from './tenant-campaign.model';
export * from './campaign-merchant.model';
export * from './tenant-campaign-tracker.model';
export * from './tracker.model';
export * from './approval-policy.model';
export * from './approval-request.model';
export * from './entity-assignment.model';
export * from './campaign-audit-trail.model';
export * from './user-notification.model';
export * from './tenant-api-key.model';

// Pre-existing, built by T-006 / T-007 — see file doc comment.
export * from './campaign-cap.model';
export * from './tenant-budget-ceiling.model';
export * from './tracker-group-def.model';

// T-005 versioning / blast / definition-request tables — see file doc comment.
export * from './rule-version.model';
export * from './reward-version.model';
export * from './rule-version-country-assignment.model';
export * from './reward-version-country-assignment.model';
export * from './version-blast.model';
export * from './version-blast-target.model';
export * from './definition-request.model';

// T-037 — the six tables that make the tracker/component hierarchy and the three reward
// attachment levels reachable from application code. Left unmodelled by T-003 (whose fixed list
// stopped at `trackers`) and explicitly delegated to this task by
// `modules/rules/campaign-usage.query.ts`'s own header. Append-only, per 05-EXECUTION-PLAN.md §3.
export * from './tracker-component.model';
export * from './tracker-tracker-component.model';
export * from './tracker-component-rule.model';
export * from './reward-campaign-assignment.model';
export * from './reward-tracker-assignment.model';
export * from './reward-component-assignment.model';

import { Country } from './country.model';
import { Tenant } from './tenant.model';
import { Merchant } from './merchant.model';
import { MerchantStore } from './merchant-store.model';
import { MerchantActivity } from './merchant-activity.model';
import { Activity } from './activity.model';
import { ActivityType } from './activity-type.model';
import { ActivityCategory } from './activity-category.model';
import { RoleNavConfig } from './role-nav-config.model';
import { RoleEntityPermission } from './role-entity-permission.model';
import { RoleDashboardWidget } from './role-dashboard-widget.model';
import { RbacCacheConfig } from './rbac-cache-config.model';
import { SystemMessage } from './system-message.model';
import { RuleMaster } from './rule-master.model';
import { RuleCategory } from './rule-category.model';
import { RuleSubCategory } from './rule-sub-category.model';
import { RuleCountryAssignment } from './rule-country-assignment.model';
import { RewardSystem } from './reward-system.model';
import { RewardPolicy } from './reward-policy.model';
import { RewardCountryAssignment } from './reward-country-assignment.model';
import { TenantCampaign } from './tenant-campaign.model';
import { CampaignMerchant } from './campaign-merchant.model';
import { TenantCampaignTracker } from './tenant-campaign-tracker.model';
import { Tracker } from './tracker.model';
import { ApprovalPolicy } from './approval-policy.model';
import { ApprovalRequest } from './approval-request.model';
import { EntityAssignment } from './entity-assignment.model';
import { CampaignAuditTrail } from './campaign-audit-trail.model';
import { UserNotification } from './user-notification.model';
import { TenantApiKey } from './tenant-api-key.model';
import { CampaignCap } from './campaign-cap.model';
import { TenantBudgetCeiling } from './tenant-budget-ceiling.model';
import { TrackerGroupDef } from './tracker-group-def.model';
import { RuleVersion } from './rule-version.model';
import { RewardVersion } from './reward-version.model';
import { RuleVersionCountryAssignment } from './rule-version-country-assignment.model';
import { RewardVersionCountryAssignment } from './reward-version-country-assignment.model';
import { VersionBlast } from './version-blast.model';
import { VersionBlastTarget } from './version-blast-target.model';
import { DefinitionRequest } from './definition-request.model';
import { TrackerComponent } from './tracker-component.model';
import { TrackerTrackerComponent } from './tracker-tracker-component.model';
import { TrackerComponentRule } from './tracker-component-rule.model';
import { RewardCampaignAssignment } from './reward-campaign-assignment.model';
import { RewardTrackerAssignment } from './reward-tracker-assignment.model';
import { RewardComponentAssignment } from './reward-component-assignment.model';

export const REWARD_CONFIG_MODELS = [
  Country,
  Tenant,
  Merchant,
  MerchantStore,
  MerchantActivity,
  Activity,
  ActivityType,
  ActivityCategory,
  RoleNavConfig,
  RoleEntityPermission,
  RoleDashboardWidget,
  RbacCacheConfig,
  SystemMessage,
  RuleMaster,
  RuleCategory,
  RuleSubCategory,
  RuleCountryAssignment,
  RewardSystem,
  RewardPolicy,
  RewardCountryAssignment,
  TenantCampaign,
  CampaignMerchant,
  TenantCampaignTracker,
  Tracker,
  ApprovalPolicy,
  ApprovalRequest,
  EntityAssignment,
  CampaignAuditTrail,
  UserNotification,
  TenantApiKey,
  CampaignCap,
  TenantBudgetCeiling,
  TrackerGroupDef,
  RuleVersion,
  RewardVersion,
  RuleVersionCountryAssignment,
  RewardVersionCountryAssignment,
  VersionBlast,
  VersionBlastTarget,
  DefinitionRequest,
  TrackerComponent,
  TrackerTrackerComponent,
  TrackerComponentRule,
  RewardCampaignAssignment,
  RewardTrackerAssignment,
  RewardComponentAssignment,
];
