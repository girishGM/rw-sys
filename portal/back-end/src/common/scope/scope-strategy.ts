/**
 * T-013 — the per-model scope strategy map (implementation note 3).
 *
 * ### Why a declared map and not a convention
 *
 * The naive rule — "add `tenant_id = :scopeTenantId` to every query" — is wrong for roughly a
 * third of the tables in this system, and wrong in both directions:
 *
 *  - `tenants` has no `tenant_id`; a `country_admin` reaches it by `country_id`, and a
 *    `tenant_admin` by primary key.
 *  - `tenant_campaigns` has a `tenant_id` but no `country_id`, so a `country_admin` needs
 *    `tenant_id IN (SELECT id FROM tenants WHERE country_id = …)` — a **subquery**, in the
 *    WHERE clause. Fetching campaigns and filtering them in JavaScript would return the right
 *    rows and still be a vulnerability: `LIMIT`/`OFFSET`, `COUNT` and every timing measurement
 *    would be computed over other countries' data (02-SECURITY.md §5.1).
 *  - `rule_master` rows owned by Super Admin carry `tenant_id IS NULL` and are visible to a
 *    country **only once assigned** (01-DATABASE.md §4). A plain `tenant_id = :t OR tenant_id
 *    IS NULL` would expose every unassigned draft rule to every tenant.
 *  - `system_messages`, `role_nav_configs` and the reference tables are global by design; a
 *    tenant predicate on them returns nothing and breaks the portal.
 *
 * So the mapping is data, declared once, reviewable in one place, and **fail-closed for
 * anything not declared**: {@link scopeStrategyFor} throws for an unregistered model rather
 * than falling back to a permissive default. A Wave 3 agent adding a table must state, in this
 * file, how each role reaches it — which is precisely the decision that should not be made
 * implicitly at a call site.
 *
 * ### How to read an entry
 *
 * Each entry declares three rules — one per non-`super_admin` scope shape:
 *
 * | field | applies to |
 * |---|---|
 * | `country`  | `country_admin` |
 * | `tenant`   | `tenant_admin`, `maker`, `checker` |
 * | `merchant` | `merchant` |
 *
 * `super_admin` is never consulted: it is global by design (T-013 implementation note 3), and
 * {@link buildScopeWhere} returns an empty clause for it before reaching this map.
 *
 * A rule is one of:
 *
 *  - `unrestricted()` — every role may see every row. Reserved for genuinely global,
 *    Super-Admin-owned configuration and reference data.
 *  - `deny()` — this role may not reach this table at all. Produces a clause that matches no
 *    row, so the outcome is an empty list or a 404, never an error that confirms existence.
 *  - `column(attribute, axis)` — `attribute = <scope value>`.
 *  - `column(attribute, axis, { orNull: true })` — as above, but `NULL` also matches, for
 *    columns where `NULL` genuinely means "applies to everyone" (`approval_policies`).
 *  - `subquery(attribute, axis, sql)` — `attribute IN (<sql>)`, with the scope value bound.
 *  - `every(...)` — all of the above conjoined.
 *
 * ### Writes are derived from reads, not declared separately
 *
 * {@link forcedWriteValues} walks the same rule the read path uses and returns the column
 * values an INSERT or UPDATE must carry. That is why TC-14 holds: a tenant-7 maker POSTing
 * `{"tenantId": 999}` gets a row with `tenant_id = 7` regardless of what the DTO said, because
 * the value is taken from the scope and overwrites whatever the caller supplied. Declaring the
 * write rules separately would have allowed the two to drift, and a drift in this direction is
 * a cross-tenant write.
 *
 * Primary-key rules are excluded from the forced set automatically (a `country_admin` reads
 * `countries` by `id = :countryId`; forcing `id` on an INSERT would be nonsense), as are
 * `orNull` rules, whose intent is ambiguous on a write.
 */
import { Op, literal, type Model, type ModelStatic, type WhereOptions } from 'sequelize';
import {
  Activity,
  ActivityCategory,
  ActivityType,
  ApprovalPolicy,
  ApprovalRequest,
  CampaignAuditTrail,
  CampaignCap,
  CampaignMerchant,
  Country,
  DefinitionRequest,
  EntityAssignment,
  FieldApiLookupProvider,
  FieldContextProvider,
  Merchant,
  MerchantActivity,
  MerchantStore,
  RbacCacheConfig,
  RewardCampaignAssignment,
  RewardCategory,
  RewardComponentAssignment,
  RewardCountryAssignment,
  RewardPolicy,
  RewardSubCategory,
  RewardSystem,
  RewardTrackerAssignment,
  RewardVersion,
  RewardVersionCountryAssignment,
  RoleDashboardWidget,
  RoleEntityPermission,
  RoleNavConfig,
  RuleCategory,
  RuleCountryAssignment,
  RuleMaster,
  RuleOperator,
  RuleResolver,
  RuleSubCategory,
  RuleVersion,
  RuleVersionCountryAssignment,
  SystemMessage,
  Tenant,
  TenantApiKey,
  TenantBudgetCeiling,
  TenantCampaign,
  TenantCampaignTracker,
  TenantCurrency,
  Tracker,
  TrackerComponent,
  TrackerComponentRule,
  TrackerGroupDef,
  TrackerTrackerComponent,
  UserNotification,
  VersionBlast,
  VersionBlastTarget,
} from '@/database/models';
import {
  ActivityExternalCode,
  PortalApprovalRequest,
  PortalAuditLog,
  PortalCampaignAuditTrail,
  PortalLoginAttempt,
  PortalPasswordReset,
  PortalRefreshToken,
  PortalSession,
  PortalUser,
  PortalUserCredential,
  PortalUserNotification,
  PortalUserRole,
} from '@/database/portal-models';
import type { RequestScope } from './scope-context';

/** Which value of the scope a rule binds to. */
export type ScopeAxis = 'country' | 'tenant' | 'merchant' | 'user';

export type ScopeRule =
  | { readonly kind: 'unrestricted' }
  | { readonly kind: 'deny' }
  | {
      readonly kind: 'column';
      readonly attribute: string;
      readonly axis: ScopeAxis;
      readonly orNull: boolean;
    }
  | {
      readonly kind: 'subquery';
      readonly attribute: string;
      readonly axis: ScopeAxis;
      readonly sql: string;
      readonly orNull: boolean;
    }
  | { readonly kind: 'every'; readonly rules: readonly ScopeRule[] };

export interface ScopeStrategy {
  /** Why this model is scoped this way. Read it before changing an entry. */
  readonly note: string;
  readonly country: ScopeRule;
  readonly tenant: ScopeRule;
  readonly merchant: ScopeRule;
}

/** Thrown when a model has no declared strategy — fail-closed, see the file header. */
export class UnscopedModelError extends Error {
  constructor(modelName: string) {
    super(
      `No scope strategy is declared for model "${modelName}". ` +
        'Declare one in src/common/scope/scope-strategy.ts; scoped access is never ' +
        'granted to an undeclared model.',
    );
    this.name = 'UnscopedModelError';
  }
}

/**
 * Thrown when the actor's role requires a scope value the token does not carry — a `maker`
 * with a `NULL` `tenant_id`, say.
 *
 * `ck_portal_users_scope` (01-DATABASE.md §2.1) makes that combination impossible to store, and
 * refresh re-derives the claims from the row on every rotation, so reaching this is evidence of
 * a corrupted or hand-forged token that nonetheless carries a valid signature. Failing is the
 * only safe response: the alternative — treating a missing tenant as "no tenant predicate" —
 * turns exactly that anomaly into a full-table read.
 */
export class IncompleteScopeError extends Error {
  constructor(axis: ScopeAxis, role: string) {
    super(
      `Role "${role}" requires a ${axis} scope value, but the request scope carries none. ` +
        'Refusing to build an unscoped query.',
    );
    this.name = 'IncompleteScopeError';
  }
}

// --- rule constructors -----------------------------------------------------------------------
// Small functions rather than object literals purely for readability of the table below: the
// table is the thing that gets reviewed, and `column('tenantId', 'tenant')` reads as the
// sentence a reviewer needs to check.

const unrestricted = (): ScopeRule => ({ kind: 'unrestricted' });
const deny = (): ScopeRule => ({ kind: 'deny' });

const column = (attribute: string, axis: ScopeAxis, options?: { orNull?: boolean }): ScopeRule => ({
  kind: 'column',
  attribute,
  axis,
  orNull: options?.orNull === true,
});

/**
 * `attribute IN (<sql>)`.
 *
 * `sql` **must** contain the literal token `:scopeValue` exactly where the scope value belongs,
 * and must contain no other placeholder. The token is renamed to a per-clause unique name when
 * the clause is built (two subqueries in one query would otherwise collide), and the value is
 * supplied through Sequelize's `replacements` — never interpolated. See
 * `scoped.repository.ts`'s header for why that is safe here and what makes it fail loudly if
 * the binding is ever lost.
 */
const subquery = (
  attribute: string,
  axis: ScopeAxis,
  sql: string,
  options?: { orNull?: boolean },
): ScopeRule => ({
  kind: 'subquery',
  attribute,
  axis,
  sql,
  orNull: options?.orNull === true,
});

const every = (...rules: readonly ScopeRule[]): ScopeRule => ({ kind: 'every', rules });

// --- reusable subquery fragments -------------------------------------------------------------
// Named once so the same reasoning is not re-derived (or mistyped) in fifteen places.

/** Every tenant inside the actor's country. The country_admin workhorse. */
const TENANTS_IN_COUNTRY =
  'SELECT t.id FROM reward_config.tenants t WHERE t.country_id = :scopeValue';

/** Every campaign the actor's merchant actually participates in (03-API-CONTRACT.md §13). */
const CAMPAIGNS_OF_MERCHANT =
  'SELECT cm.campaign_id FROM reward_config.campaign_merchants cm ' +
  "WHERE cm.merchant_id = :scopeValue AND cm.status = 'active'";

/** Global rules assigned to the actor's country (01-DATABASE.md §4). */
const RULES_ASSIGNED_TO_COUNTRY =
  'SELECT rca.rule_id FROM reward_config.rule_country_assignments rca WHERE rca.country_id = :scopeValue';

/** Global rewards assigned to the actor's country. Mirror of the rule side. */
const REWARDS_ASSIGNED_TO_COUNTRY =
  'SELECT rca.reward_id FROM reward_config.reward_country_assignments rca WHERE rca.country_id = :scopeValue';

/** Trackers belonging to the actor's tenant. */
const TRACKERS_OF_TENANT =
  'SELECT tr.id FROM reward_config.trackers tr WHERE tr.tenant_id = :scopeValue';

/** Trackers belonging to any tenant in the actor's country. */
const TRACKERS_IN_COUNTRY =
  'SELECT tr.id FROM reward_config.trackers tr ' +
  'JOIN reward_config.tenants t ON t.id = tr.tenant_id WHERE t.country_id = :scopeValue';

/** Portal users inside the actor's tenant — for tables keyed by `user_id`. */
const USERS_IN_TENANT =
  'SELECT u.id FROM reward_portal.portal_users u WHERE u.tenant_id = :scopeValue';

/** Portal users inside the actor's country. */
const USERS_IN_COUNTRY =
  'SELECT u.id FROM reward_portal.portal_users u WHERE u.country_id = :scopeValue';

/**
 * Tracker components reachable from the actor's own tenant (T-037).
 *
 * `tracker_components` **does** carry `tenant_id`, so the `tenant` axis needs no subquery at
 * all; these two exist for the `country_admin` axis and for the link/binding tables that carry
 * a `component_id` but no tenant column of their own (`tracker_tracker_components`).
 */
const COMPONENTS_IN_COUNTRY =
  'SELECT tc.id FROM reward_config.tracker_components tc ' +
  'JOIN reward_config.tenants t ON t.id = tc.tenant_id WHERE t.country_id = :scopeValue';

const COMPONENTS_OF_TENANT =
  'SELECT tc.id FROM reward_config.tracker_components tc WHERE tc.tenant_id = :scopeValue';

// --- the map ---------------------------------------------------------------------------------

/**
 * The declared strategy for every model registered on the application connection.
 *
 * Keyed by the model **class**, not its name: a typo is then a compile error rather than a
 * silently missing entry that would be caught only when {@link UnscopedModelError} fires in
 * production.
 */
const STRATEGIES = new Map<ModelStatic<Model>, ScopeStrategy>([
  // === Reference and global configuration ====================================================
  // 01-DATABASE.md §3 grants `reward_app` SELECT-only on the reference tables and describes
  // them as "Super-Admin-owned reference data". They carry a `tenant_id` column in the legacy
  // schema but are not tenant data; scoping them by tenant would empty every dropdown in the
  // portal. Writes are impossible at the privilege level, so `unrestricted` here cannot become
  // a write path.
  [
    RuleCategory,
    {
      note: 'Super-Admin-owned reference data (01-DATABASE.md §3); read-only at the DB grant level.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    RuleSubCategory,
    {
      note: 'Reference data; no tenant column at all.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    RuleResolver,
    {
      note:
        'T-102 registry — pluggable fact resolvers. Seed-managed reference data, no tenant ' +
        'column at all; every role needs it to render a resolver picker (T-108).',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    RuleOperator,
    {
      note:
        'T-102 registry — comparison operators. Seed-managed reference data, no tenant column ' +
        'at all; every role needs it to render an operator picker (T-108).',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    FieldContextProvider,
    {
      note:
        'T-121 registry — field value sources that read the campaign draft. Seed-managed ' +
        'reference data, no tenant column at all; every role needs it to render a value-source ' +
        'picker. Writes are super_admin-only, enforced at the controller and again in the ' +
        'service — not by this strategy.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    FieldApiLookupProvider,
    {
      note:
        'T-121 registry — field value sources that call a pre-registered endpoint. Same ' +
        'reasoning as FieldContextProvider above. `auth_config_enc` is encrypted at rest and ' +
        'never reaches a response DTO, so `unrestricted` reads expose no credential.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    RewardCategory,
    {
      note:
        'T-116 — the reward equivalent of `RuleCategory` above, same reasoning: Super-Admin-' +
        'owned reference data, carries a `tenant_id` column that is a NOT NULL technicality, ' +
        'not a real scope (every role needs the full category list to render a picker).',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    RewardSubCategory,
    {
      note: 'T-116 — the reward equivalent of `RuleSubCategory` above. Reference data.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    ActivityCategory,
    {
      note: 'Reference data (01-DATABASE.md §3).',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    ActivityType,
    {
      note: 'Reference data (01-DATABASE.md §3).',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  // The four RBAC/UI configuration tables are what /me/bootstrap is built from (T-015). Every
  // role must be able to read its own configuration, and rows are keyed by role, not by tenant.
  // Write access is gated by `@Roles('super_admin')` on T-033's endpoints, not by scope.
  [
    RoleNavConfig,
    {
      note: 'Global UI configuration keyed by role (00-ARCHITECTURE.md §7); every role reads it.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    RoleEntityPermission,
    {
      note: 'The permission matrix itself. Global, keyed by role.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    RoleDashboardWidget,
    {
      note: 'Global dashboard configuration keyed by role.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    RbacCacheConfig,
    {
      note: 'Cache tuning and rbac_version counters. Global.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],
  [
    SystemMessage,
    {
      note: 'The localisable message catalogue every error code resolves through. Global.',
      country: unrestricted(),
      tenant: unrestricted(),
      merchant: unrestricted(),
    },
  ],

  // === Geography and tenancy ==================================================================
  [
    Country,
    {
      note: 'A non-super-admin sees exactly its own country, by primary key.',
      country: column('id', 'country'),
      tenant: column('id', 'country'),
      merchant: column('id', 'country'),
    },
  ],
  [
    Tenant,
    {
      note: 'country_admin sees its country’s tenants (TC-8/TC-9); everyone below sees only its own.',
      country: column('countryId', 'country'),
      tenant: column('id', 'tenant'),
      merchant: column('id', 'tenant'),
    },
  ],
  [
    Merchant,
    {
      note: 'country_admin reaches merchants through their tenant; a merchant sees only itself.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: every(column('tenantId', 'tenant'), column('id', 'merchant')),
    },
  ],
  [
    MerchantStore,
    {
      note: 'Stores follow their merchant.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: every(column('tenantId', 'tenant'), column('merchantId', 'merchant')),
    },
  ],
  [
    MerchantActivity,
    {
      note: 'Merchant↔activity links follow their merchant.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: every(column('tenantId', 'tenant'), column('merchantId', 'merchant')),
    },
  ],
  [
    Activity,
    {
      note: 'Tenant-owned activity catalogue.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: column('tenantId', 'tenant'),
    },
  ],
  [
    ActivityExternalCode,
    {
      note: 'T-171 — the external/transaction-type codes an activity is also known by (reward_portal, because R1 forbids new reward_config DDL). It hangs off the tenant-owned activity catalogue above and carries its own tenant_id column, so it takes exactly the same rule as Activity: a unique index cannot span a cross-schema subquery and this predicate needs a real column to bind to, which is why the tenant is stored on the row rather than joined through activities.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: column('tenantId', 'tenant'),
    },
  ],

  // === Rules and rewards ======================================================================
  // 00-ARCHITECTURE.md §5.2: Super Admin is the only author. Everyone else sees a global row
  // *only* once it is assigned to their country — which is why these are assignment subqueries
  // and not `tenant_id = :t OR tenant_id IS NULL`. The latter would expose every unassigned
  // draft. T-031's `ruleVisibilityScope(countryId)` helper must be built on this entry rather
  // than beside it; see the T-013 completion report.
  [
    RuleMaster,
    {
      note: 'Global rules are visible only where assigned (01-DATABASE.md §4). Merchants have no rule permission at all.',
      country: subquery('id', 'country', RULES_ASSIGNED_TO_COUNTRY),
      tenant: subquery('id', 'country', RULES_ASSIGNED_TO_COUNTRY),
      merchant: deny(),
    },
  ],
  [
    RuleCountryAssignment,
    {
      note: 'An assignment row is visible to the country it assigns to.',
      country: column('countryId', 'country'),
      tenant: column('countryId', 'country'),
      merchant: deny(),
    },
  ],
  [
    RuleVersion,
    {
      note: 'A version follows its rule’s visibility.',
      country: subquery('ruleId', 'country', RULES_ASSIGNED_TO_COUNTRY),
      tenant: subquery('ruleId', 'country', RULES_ASSIGNED_TO_COUNTRY),
      merchant: deny(),
    },
  ],
  [
    RuleVersionCountryAssignment,
    {
      note: 'Version→country assignment; visible to the assigned country.',
      country: column('countryId', 'country'),
      tenant: column('countryId', 'country'),
      merchant: deny(),
    },
  ],
  [
    RewardSystem,
    {
      note: 'Mirror of RuleMaster — assignment-gated, Super-Admin-authored.',
      country: subquery('id', 'country', REWARDS_ASSIGNED_TO_COUNTRY),
      tenant: subquery('id', 'country', REWARDS_ASSIGNED_TO_COUNTRY),
      merchant: deny(),
    },
  ],
  [
    RewardPolicy,
    {
      note: 'A policy follows its reward system’s visibility (no scope column of its own).',
      country: subquery('rewardSystemId', 'country', REWARDS_ASSIGNED_TO_COUNTRY),
      tenant: subquery('rewardSystemId', 'country', REWARDS_ASSIGNED_TO_COUNTRY),
      merchant: deny(),
    },
  ],
  [
    RewardCountryAssignment,
    {
      note: 'Mirror of RuleCountryAssignment.',
      country: column('countryId', 'country'),
      tenant: column('countryId', 'country'),
      merchant: deny(),
    },
  ],
  [
    RewardVersion,
    {
      note: 'Mirror of RuleVersion.',
      country: subquery('rewardId', 'country', REWARDS_ASSIGNED_TO_COUNTRY),
      tenant: subquery('rewardId', 'country', REWARDS_ASSIGNED_TO_COUNTRY),
      merchant: deny(),
    },
  ],
  [
    RewardVersionCountryAssignment,
    {
      note: 'Mirror of RuleVersionCountryAssignment.',
      country: column('countryId', 'country'),
      tenant: column('countryId', 'country'),
      merchant: deny(),
    },
  ],
  [
    VersionBlast,
    {
      note: 'Blasts are authored and read by Super Admin only (T-041); nobody below sees the blast row.',
      country: deny(),
      tenant: deny(),
      merchant: deny(),
    },
  ],
  [
    VersionBlastTarget,
    {
      note: 'A country may see the blast rows targeting it — that is its own delivery status.',
      country: column('countryId', 'country'),
      tenant: deny(),
      merchant: deny(),
    },
  ],
  [
    DefinitionRequest,
    {
      note: 'A request is visible to the country or tenant that raised it (T-042).',
      country: column('requestingCountryId', 'country'),
      tenant: column('requestingTenantId', 'tenant'),
      merchant: deny(),
    },
  ],

  // === Campaigns ==============================================================================
  [
    TenantCampaign,
    {
      note: 'The task’s worked example. country_admin needs the tenants-in-country subquery (note 3); a merchant sees only campaigns it participates in (TC-10/TC-11).',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: every(
        column('tenantId', 'tenant'),
        subquery('id', 'merchant', CAMPAIGNS_OF_MERCHANT),
      ),
    },
  ],
  [
    CampaignMerchant,
    {
      note: 'Participation rows: a merchant sees only its own.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: every(column('tenantId', 'tenant'), column('merchantId', 'merchant')),
    },
  ],
  [
    TenantCampaignTracker,
    {
      note: 'Campaign composition follows the campaign.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: every(
        column('tenantId', 'tenant'),
        subquery('campaignId', 'merchant', CAMPAIGNS_OF_MERCHANT),
      ),
    },
  ],
  [
    Tracker,
    {
      note: 'Tenant-owned tracker definitions.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    TrackerGroupDef,
    {
      note: 'Groups have no tenant column; they follow their tracker (T-007).',
      country: subquery('trackerId', 'country', TRACKERS_IN_COUNTRY),
      tenant: subquery('trackerId', 'tenant', TRACKERS_OF_TENANT),
      merchant: deny(),
    },
  ],
  [
    CampaignCap,
    {
      note: 'Caps belong to a campaign inside a tenant (T-006).',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    TenantBudgetCeiling,
    {
      note: 'Country Admin sets ceilings for its tenants; a tenant sees its own (01-DATABASE.md §5.1).',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    TenantCurrency,
    {
      note: "T-126 — a tenant’s supported-currency list (13-REWARD-MASTER-VALUE-SOURCES.md §4). Tenant-wide, not merchant-specific — a merchant reaches it by its own tenant, the same \"axis under a different key\" shape Tenant’s own merchant entry uses (`column('id', 'tenant')` there), unlike TenantBudgetCeiling above, which denies merchant outright: this table has a `role_entity_permissions` row for every role (T126_002), including merchant, so the merchant axis must actually resolve rather than deny.",
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: column('tenantId', 'tenant'),
    },
  ],
  [
    CampaignAuditTrail,
    {
      note: 'Audit rows carry the campaign’s tenant; a merchant sees only its own campaigns’ trail.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: every(
        column('tenantId', 'tenant'),
        subquery('campaignId', 'merchant', CAMPAIGNS_OF_MERCHANT),
      ),
    },
  ],

  // === The journey: components, links, rule bindings, reward attachments (T-037) ==============
  // Six entries, all appended by T-037 — the task that owns the tracker/component hierarchy
  // (`modules/rules/campaign-usage.query.ts`'s own header delegates them here explicitly). Each
  // states, per this file's contract, how every role reaches the table.
  //
  // **`merchant: deny()` on all six, and that is not an oversight.** A merchant sees campaigns it
  // participates in (`TenantCampaign`'s own entry), not the rule and reward mechanics inside
  // them: 03-API-CONTRACT.md §13 gives the merchant role exactly three read endpoints, none of
  // which exposes a component's completion rules or a reward attachment. T-039 builds that
  // surface from the campaign header, not from these tables.
  [
    TrackerComponent,
    {
      note: 'Tenant-owned component definitions; the campaign they belong to is derived through tracker_tracker_components, never stored here (T-037).',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    TrackerTrackerComponent,
    {
      note: 'The authoritative tracker↔component link (12-CAMPAIGN-STRUCTURE.md §1.3). No tenant column of its own — it follows its tracker, and is additionally narrowed by its component so a link can never straddle two tenants.',
      country: every(
        subquery('trackerId', 'country', TRACKERS_IN_COUNTRY),
        subquery('componentId', 'country', COMPONENTS_IN_COUNTRY),
      ),
      tenant: every(
        subquery('trackerId', 'tenant', TRACKERS_OF_TENANT),
        subquery('componentId', 'tenant', COMPONENTS_OF_TENANT),
      ),
      merchant: deny(),
    },
  ],
  [
    TrackerComponentRule,
    {
      note: 'Rule bindings carry their own tenant_id (fk_tcr_tenant). Rules bind to a component, never to the campaign (04-FRONTEND.md §5.1).',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    RewardCampaignAssignment,
    {
      note: 'Campaign-level reward attachment; tenant-owned (fk_rca_tenant2).',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    RewardTrackerAssignment,
    {
      note: 'Tracker-level reward attachment; tenant-owned (fk_rta_tenant).',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    RewardComponentAssignment,
    {
      note: 'Component-level reward attachment; tenant-owned (fk_rca_tenant).',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],

  // === Approvals, assignments, notifications ==================================================
  [
    ApprovalPolicy,
    {
      note: 'A NULL tenant_id is a global default policy that must remain visible to every tenant — the one legitimate use of orNull in this map.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY, { orNull: true }),
      tenant: column('tenantId', 'tenant', { orNull: true }),
      merchant: deny(),
    },
  ],
  [
    ApprovalRequest,
    {
      note: 'Maker/checker workflow rows, tenant-owned.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    PortalApprovalRequest,
    {
      note: 'T-037 — the portal-side replacement for ApprovalRequest above (T037_001), whose requested_by/reviewed_by FKs point at admin_users and cannot hold a maker or checker (G1). Same tenant-owned rule as the table it replaces; a merchant has no approval permission at all (03-API-CONTRACT.md §12).',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    PortalCampaignAuditTrail,
    {
      note: 'T-037 — the portal-side replacement for CampaignAuditTrail above (T037_002), closing the gap audit.service.ts#recordDomainEvent raised and left open. Same tenant-owned rule as the table it replaces, including the merchant carve-out to its own campaigns.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: every(
        column('tenantId', 'tenant'),
        subquery('campaignId', 'merchant', CAMPAIGNS_OF_MERCHANT),
      ),
    },
  ],
  [
    EntityAssignment,
    {
      note: 'Tenant-owned assignment rows.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
  [
    UserNotification,
    {
      note: '"own only" (03-API-CONTRACT.md §14) — scoped to the recipient, not the tenant, for every role below super_admin. DEPRECATED (T-040 retry 1): reward_config.user_notifications.user_id cannot represent a real recipient (fk_un_user -> admin_users, unbridgeable for maker/checker, G1) — nothing in this codebase writes or reads through this model any more. Left declared, not deleted, because it is still a registered model on the connection and this map is fail-closed. See PortalUserNotification below for the live table.',
      country: column('userId', 'user'),
      tenant: column('userId', 'user'),
      merchant: column('userId', 'user'),
    },
  ],
  [
    PortalUserNotification,
    {
      note: 'T-040 retry 1 — the reward_portal-owned replacement for UserNotification above, with a real portal_users FK (T040_001_portal_user_notifications). Same "own only" rule (03-API-CONTRACT.md §14): scoped to the recipient, not the tenant, for every role below super_admin.',
      country: column('userId', 'user'),
      tenant: column('userId', 'user'),
      merchant: column('userId', 'user'),
    },
  ],
  [
    TenantApiKey,
    {
      note: 'Tenant credentials. Never reachable below tenant_admin, and never by a merchant.',
      country: subquery('tenantId', 'country', TENANTS_IN_COUNTRY),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],

  // === reward_portal ==========================================================================
  [
    PortalUser,
    {
      note: 'The delegation chain of 00-ARCHITECTURE.md §5: a country_admin sees its country’s users, a tenant its own, a merchant only its merchant’s.',
      country: column('countryId', 'country'),
      tenant: column('tenantId', 'tenant'),
      merchant: every(column('tenantId', 'tenant'), column('merchantId', 'merchant')),
    },
  ],
  [
    PortalUserRole,
    {
      note: 'The future multi-role join table (unused in v1). Follows the user it names.',
      country: subquery('userId', 'country', USERS_IN_COUNTRY),
      tenant: subquery('userId', 'tenant', USERS_IN_TENANT),
      merchant: deny(),
    },
  ],
  [
    PortalUserCredential,
    {
      note: 'Password hashes. Reached only by CredentialRepository’s own parameterised SQL, never through a scoped query — denied to every role so a stray call fails rather than reads.',
      country: deny(),
      tenant: deny(),
      merchant: deny(),
    },
  ],
  [
    PortalSession,
    {
      note: 'Own sessions only (03-API-CONTRACT.md §3). Session validation itself does not use this path — see session.repository.ts.',
      country: column('userId', 'user'),
      tenant: column('userId', 'user'),
      merchant: column('userId', 'user'),
    },
  ],
  [
    PortalRefreshToken,
    {
      note: 'Token material. Own rows only, and in practice never read through this path.',
      country: column('userId', 'user'),
      tenant: column('userId', 'user'),
      merchant: column('userId', 'user'),
    },
  ],
  [
    PortalPasswordReset,
    {
      note: 'Single-use reset tokens; looked up by digest in AuthService, never listed.',
      country: deny(),
      tenant: deny(),
      merchant: deny(),
    },
  ],
  [
    PortalLoginAttempt,
    {
      note: 'Lockout telemetry, including attempts against addresses that do not exist. Super Admin only.',
      country: deny(),
      tenant: deny(),
      merchant: deny(),
    },
  ],
  [
    PortalAuditLog,
    {
      note: '`/audit/portal` is super_admin only (03-API-CONTRACT.md §14); the country/tenant columns scope the rest fail-closed.',
      country: column('countryId', 'country'),
      tenant: column('tenantId', 'tenant'),
      merchant: deny(),
    },
  ],
]);

/** The declared strategy for `model`, or {@link UnscopedModelError}. */
export function scopeStrategyFor(model: ModelStatic<Model>): ScopeStrategy {
  const strategy = STRATEGIES.get(model);
  if (strategy === undefined) throw new UnscopedModelError(model.name);
  return strategy;
}

/** Every model with a declared strategy. Used by the completeness test, not by request code. */
export function scopedModels(): readonly ModelStatic<Model>[] {
  return [...STRATEGIES.keys()];
}

/**
 * The rule that applies to `role`.
 *
 * `super_admin` is handled by the caller and never reaches here; it is listed in the switch so
 * that adding a seventh role becomes a compile error rather than a silent fall-through to a
 * permissive branch.
 */
export function ruleForRole(strategy: ScopeStrategy, role: RequestScope['role']): ScopeRule {
  switch (role) {
    case 'super_admin':
      return unrestricted();
    case 'country_admin':
      return strategy.country;
    case 'tenant_admin':
    case 'maker':
    case 'checker':
      return strategy.tenant;
    case 'merchant':
      return strategy.merchant;
  }
}

/**
 * The scope value for an axis, or {@link IncompleteScopeError}.
 *
 * The `Number.isSafeInteger` check is not paranoia about the JWT — the claim is signed — it is
 * a type-level backstop for the fact that these values end up next to raw SQL. If a scope value
 * were ever anything but an integer, the correct behaviour is to refuse to build the query, not
 * to discover it downstream.
 */
function scopeValue(scope: RequestScope, axis: ScopeAxis): number {
  const raw =
    axis === 'country'
      ? scope.countryId
      : axis === 'tenant'
        ? scope.tenantId
        : axis === 'merchant'
          ? scope.merchantId
          : scope.userId;

  if (raw === null || !Number.isSafeInteger(raw)) throw new IncompleteScopeError(axis, scope.role);
  return raw;
}

/** A clause that matches nothing, expressed so that Postgres can short-circuit it. */
const MATCHES_NOTHING: WhereOptions = literal('1 = 0');

/**
 * The result of compiling a rule: the Sequelize `where` fragment, plus any bound values the
 * subqueries inside it need.
 */
export interface CompiledScope {
  readonly where: WhereOptions | null;
  readonly replacements: Readonly<Record<string, number>>;
}

/**
 * Compiles the scope clause for one model and one actor.
 *
 * Returns `where: null` for `super_admin` and for `unrestricted` models — "add nothing to the
 * caller's WHERE" — which is a different thing from `{}`, and is kept distinct so the caller
 * never conjoins an empty object and produces `WHERE ()`.
 */
export function buildScopeWhere(model: ModelStatic<Model>, scope: RequestScope): CompiledScope {
  // Global by design (T-013 implementation note 3). Deliberately checked before the strategy
  // lookup, so a super_admin request is never blocked by an undeclared model — but note that
  // this is the *only* role that skips the map.
  if (scope.role === 'super_admin') return { where: null, replacements: {} };

  return compileRule(ruleForRole(scopeStrategyFor(model), scope.role), model, scope);
}

/**
 * Compiles one rule, independently of the map.
 *
 * Exported so the clause compiler can be exercised with hand-built rules — in particular the
 * `every()` collapse branches, which no *current* entry in the map reaches (every `every()` in
 * the table today has exactly two contributing members) but which a future entry will the moment
 * somebody writes `every(unrestricted(), column(…))`. Testing them through a distorted map entry
 * would mean shipping a strategy that exists only to be tested; testing them here does not.
 */
export function compileRule(
  rule: ScopeRule,
  model: ModelStatic<Model>,
  scope: RequestScope,
): CompiledScope {
  const replacements: Record<string, number> = {};
  const where = compile(rule, model, scope, replacements, { next: 0 });
  return { where, replacements };
}

/** Mutable counter, so every subquery in one query gets a distinct replacement name. */
interface NameCounter {
  next: number;
}

function compile(
  rule: ScopeRule,
  model: ModelStatic<Model>,
  scope: RequestScope,
  replacements: Record<string, number>,
  counter: NameCounter,
): WhereOptions | null {
  switch (rule.kind) {
    case 'unrestricted':
      return null;

    case 'deny':
      // Not an error: "this role cannot see this table" must look exactly like "there are no
      // rows", so a list is empty and a lookup 404s (02-SECURITY.md §5.1). An exception here
      // would be a side channel confirming the table exists and is guarded.
      return MATCHES_NOTHING;

    case 'column': {
      const value = scopeValue(scope, rule.axis);
      const eq = { [rule.attribute]: value } as WhereOptions;
      return rule.orNull ? ({ [Op.or]: [eq, { [rule.attribute]: null }] } as WhereOptions) : eq;
    }

    case 'subquery': {
      const value = scopeValue(scope, rule.axis);
      const name = `rsScope${counter.next++}`;
      replacements[name] = value;

      // The only textual substitution here is placeholder-name → placeholder-name. Both sides
      // are compile-time constants of this file; the *value* never touches the SQL string and
      // is supplied by Sequelize's `replacements`, which escapes it. If that binding is ever
      // dropped, Sequelize throws "Named replacement has no entry in the replacement map"
      // rather than running the query — a fail-loud property this module relies on and
      // `scoped.repository.spec.ts` asserts.
      const sql = rule.sql.replace(/:scopeValue\b/g, `:${name}`);
      const inClause = {
        [rule.attribute]: { [Op.in]: literal(`(${sql})`) },
      } as WhereOptions;

      return rule.orNull
        ? ({ [Op.or]: [inClause, { [rule.attribute]: null }] } as WhereOptions)
        : inClause;
    }

    case 'every': {
      const parts = rule.rules
        .map((inner) => compile(inner, model, scope, replacements, counter))
        .filter((part): part is WhereOptions => part !== null);

      if (parts.length === 0) return null;
      if (parts.length === 1) return parts[0];
      return { [Op.and]: parts } as WhereOptions;
    }
  }
}

/**
 * The column values an INSERT or UPDATE must carry for this actor — the write half of the same
 * declaration. See the file header for why this is derived rather than declared.
 *
 * Only unconditional, non-primary-key `column` rules contribute. A subquery describes
 * membership, not a value, and cannot be forced onto a row; a primary-key rule describes how a
 * row is *found*, not what it should contain.
 */
export function forcedWriteValues(
  model: ModelStatic<Model>,
  scope: RequestScope,
): Readonly<Record<string, number>> {
  if (scope.role === 'super_admin') return {};

  const forced: Record<string, number> = {};
  collectForced(ruleForRole(scopeStrategyFor(model), scope.role), model, scope, forced);
  return forced;
}

function collectForced(
  rule: ScopeRule,
  model: ModelStatic<Model>,
  scope: RequestScope,
  forced: Record<string, number>,
): void {
  switch (rule.kind) {
    case 'unrestricted':
    case 'deny':
    case 'subquery':
      return;

    case 'column':
      if (rule.orNull) return;
      if (rule.attribute === model.primaryKeyAttribute) return;
      forced[rule.attribute] = scopeValue(scope, rule.axis);
      return;

    case 'every':
      for (const inner of rule.rules) collectForced(inner, model, scope, forced);
      return;
  }
}

/**
 * Whether this actor is denied the model outright.
 *
 * Used by `ScopedRepository` to refuse a **write** rather than silently write zero rows: a
 * denied read is legitimately an empty list, but a denied write that reports success is a lie,
 * and a `create()` has no WHERE clause to be constrained by at all.
 */
export function isDenied(model: ModelStatic<Model>, scope: RequestScope): boolean {
  if (scope.role === 'super_admin') return false;
  return containsDeny(ruleForRole(scopeStrategyFor(model), scope.role));
}

function containsDeny(rule: ScopeRule): boolean {
  if (rule.kind === 'deny') return true;
  if (rule.kind === 'every') return rule.rules.some(containsDeny);
  return false;
}
