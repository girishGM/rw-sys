/**
 * T-092 — `DashboardService`: the data behind every `role_dashboard_widgets` row.
 *
 * ### The defect this module fixes
 *
 * `front-end/src/features/dashboard/widgets/api.ts` has called `GET /dashboard/widgets/:widgetKey`
 * since T-023, and nothing has ever served that route: `grep -rn "dashboard" back-end/src/modules`
 * found no controller before this task. Every widget tile, for every one of the six roles,
 * therefore rendered its error state against a real running system (T-092's own evidence, and
 * `widgetRegistry.ts`'s file header before this task edited it). This module is the missing
 * piece: one resolver per seeded `widget_key` (`T004_003_seed_role_dashboard_widgets.ts`,
 * `01-DATABASE.md` §5.3), dispatched from {@link getWidgetData}.
 *
 * ### Two gates before any resolver runs
 *
 * 1. **The widget must be assigned to the caller's role, and enabled** — checked against
 *    `role_dashboard_widgets` itself (`RoleDashboardWidget`, `unrestricted()` in
 *    `scope-strategy.ts`: every role reads its own configuration). A `checker` asking for
 *    `kpi_countries` (a `super_admin`-only tile) gets the same `404 NOT_FOUND` an unassigned or
 *    misspelled key gets — indistinguishable by construction, the same shape `ScopedRepository`
 *    already gives cross-tenant reads (02-SECURITY.md §5.1) — rather than a 403 that would
 *    confirm the widget exists. This is *in addition to* the resolvers' own reliance on
 *    `ScopedRepository` scoping; it exists so a role can never even dispatch into a resolver whose
 *    query shape assumes a scope axis that role's actor does not carry (`IncompleteScopeError`
 *    would otherwise be the failure mode for, say, `merchant` requesting `kpi_countries`).
 * 2. **Every resolver reads through `ScopedRepository`, never a raw model call (R2).** No
 *    resolver below re-derives who may see what — `scope-strategy.ts`'s declared strategy for
 *    each model is the single source of truth, exactly as it is for every other Wave 3 module.
 *    Nothing here needs `assertRole`: unlike `/countries`, `/rules` or `/rewards`, this route
 *    performs no write and grants no authority beyond "read your own configured tiles" (gate 1
 *    above already enforces that, per role, from data).
 *
 * ### Reuse over re-derivation, where a purpose-built method already exists
 *
 * `list_tenants_without_ceiling` and the four `merchant`-role widgets are **not** recomputed here
 * from `ScopedRepository` directly — `TenantsService#listTenantsWithoutCeiling` and
 * `MerchantPortalService#getSummary` already are that data, and both files' own headers name this
 * exact gap (`tenants.service.ts`: *"wiring `list_tenants_without_ceiling`'s `/dashboard/widgets/
 * ...` route to it is for whichever task adds the missing dashboard-routing module"*). Recomputing
 * either here would be a second implementation of a non-trivial rule (`TenantsService`'s "a tenant
 * with no ceiling row of any unit is unconfigured") that could drift from the one `/tenants`
 * itself exposes. Every other widget is a small enough query that duplicating it here, direct
 * against `ScopedRepository`, is the same shape `merchant-portal.service.ts#getSummary` and
 * `countries.service.ts#summary` already use for their own dashboard-shaped reads — there is no
 * third module whose job these are.
 *
 * ### Where a value is genuinely unavailable
 *
 * `chart_campaign_performance` returns `{ series: [] }`, never a fabricated series —
 * `MerchantPortalService#getSummary`'s own `campaignPerformance` field already documents *why*
 * (no redemption/transaction data source exists in `reward_config` yet); `ChartWidget.tsx` renders
 * an honest "No data yet" for an empty series, so no `available`/`reason` field is needed on this
 * route's own DTO (unlike `MerchantSummaryDto`'s, which predates this route).
 */
import { Injectable } from '@nestjs/common';
import { Op } from 'sequelize';
import { NotFoundError } from '@/common/errors/app-error';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { Country, Merchant, RoleDashboardWidget, Tenant, TenantCampaign } from '@/database/models';
import { PortalApprovalRequest, PortalAuditLog, PortalUser } from '@/database/portal-models';
import { actorRefId, actorRefText } from '@/modules/campaigns/actor-ref';
import { APPROVAL_STATUS, CAMPAIGN_STATUS } from '@/modules/campaigns/campaigns.constants';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { MERCHANT_ACTIVE_STATUS } from '@/modules/merchants/merchants.constants';
import { MerchantPortalService } from '@/modules/merchant-portal/merchant-portal.service';
import { TenantsService } from '@/modules/tenants/tenants.service';
import { USER_ACTIVE_STATUS } from '@/modules/users/users.constants';
import { DASHBOARD_LIST_LIMIT, WIDGET_KEY } from './dashboard.constants';
import {
  toChartWidgetData,
  toKpiWidgetData,
  toListWidgetData,
  type WidgetData,
} from './dto/dashboard-widget-response.dto';

/** One resolver per seeded `widget_key`. Keyed by the literal string rather than by
 * `WIDGET_KEY[...]` so an unhandled key is a `Record` type error, not a silent `undefined`. */
type WidgetResolver = (actor: AuthenticatedUser) => Promise<WidgetData>;

@Injectable()
export class DashboardService {
  constructor(
    private readonly scoped: ScopedRepository,
    private readonly tenants: TenantsService,
    private readonly merchantPortal: MerchantPortalService,
  ) {}

  /**
   * `GET /dashboard/widgets/:widgetKey` (T-092 TC-1/TC-2).
   *
   * Gate 1 (this method's own header, point 1): a widget not seeded — enabled — for this actor's
   * role 404s here, before any resolver-specific query runs.
   */
  async getWidgetData(actor: AuthenticatedUser, widgetKey: string): Promise<WidgetData> {
    const assignedCount = await this.scoped.count(RoleDashboardWidget, {
      where: { role: actor.role, widgetKey, enabled: true },
    });
    if (assignedCount === 0) {
      throw new NotFoundError({ logContext: { role: actor.role, widgetKey } });
    }

    const resolver = this.resolvers[widgetKey];
    if (resolver === undefined) {
      // Reachable only if `role_dashboard_widgets` carries a key this module has not yet added a
      // resolver for (a Super-Admin-authored custom widget, say) — the same "unknown key
      // degrades, never throws past this point" contract `WIDGET_REGISTRY` keeps on the front
      // end (04-FRONTEND.md §3), mirrored server-side as a 404 rather than a 500.
      throw new NotFoundError({ logContext: { role: actor.role, widgetKey } });
    }
    return resolver(actor);
  }

  private readonly resolvers: Readonly<Record<string, WidgetResolver>> = {
    // === super_admin ============================================================================
    [WIDGET_KEY.KPI_COUNTRIES]: async () => toKpiWidgetData(await this.scoped.count(Country)),
    [WIDGET_KEY.KPI_TENANTS]: async () => toKpiWidgetData(await this.scoped.count(Tenant)),
    [WIDGET_KEY.KPI_ACTIVE_CAMPAIGNS]: async () =>
      toKpiWidgetData(
        await this.scoped.count(TenantCampaign, { where: { status: CAMPAIGN_STATUS.ACTIVE } }),
      ),
    [WIDGET_KEY.CHART_CAMPAIGNS_BY_COUNTRY]: async () => this.chartCampaignsByCountry(),
    [WIDGET_KEY.LIST_RECENT_ADMIN_ACTIVITY]: async () => this.listRecentAdminActivity(),

    // === country_admin ==========================================================================
    [WIDGET_KEY.KPI_PENDING_APPROVALS]: async () =>
      toKpiWidgetData(
        await this.scoped.count(PortalApprovalRequest, {
          where: { status: APPROVAL_STATUS.PENDING },
        }),
      ),
    [WIDGET_KEY.LIST_RECENT_TENANTS]: async () => this.listRecentTenants(),
    [WIDGET_KEY.LIST_TENANTS_WITHOUT_CEILING]: async () => {
      const rows = await this.tenants.listTenantsWithoutCeiling();
      return toListWidgetData(
        rows
          .slice(0, DASHBOARD_LIST_LIMIT)
          .map((tenant) => ({ id: tenant.id, primary: tenant.name, secondary: tenant.code })),
      );
    },

    // === tenant_admin ============================================================================
    [WIDGET_KEY.KPI_USERS]: async () =>
      toKpiWidgetData(
        await this.scoped.count(PortalUser, { where: { status: USER_ACTIVE_STATUS } }),
      ),
    [WIDGET_KEY.KPI_MERCHANTS]: async () =>
      toKpiWidgetData(
        await this.scoped.count(Merchant, { where: { status: MERCHANT_ACTIVE_STATUS } }),
      ),
    // "Campaigns by Status" is seeded as a single `kpi_*` tile (`widgetRegistry.ts` builds it with
    // `createKpiWidget`, not `createChartWidget`), so it can carry one number, not a breakdown —
    // neither `01-DATABASE.md` §5.3 nor `04-FRONTEND.md` says which. Read as "how many of this
    // tenant's campaigns are currently live in the pipeline" (every status short of `archived`,
    // the terminal one) — the single number closest to what a tenant admin glancing at a KPI tile
    // titled "Campaigns by Status" wants first. Flagged as a genuine interpretation, not a
    // transcription, in the completion report.
    [WIDGET_KEY.KPI_CAMPAIGNS_BY_STATUS]: async () =>
      toKpiWidgetData(
        await this.scoped.count(TenantCampaign, {
          where: { status: { [Op.ne]: CAMPAIGN_STATUS.ARCHIVED } },
        }),
      ),
    [WIDGET_KEY.LIST_PENDING_APPROVALS]: async () => {
      const rows = await this.scoped.listAll(PortalApprovalRequest, {
        where: { status: APPROVAL_STATUS.PENDING },
        order: [['requestedAt', 'ASC']],
        limit: DASHBOARD_LIST_LIMIT,
      });
      return toListWidgetData(rows.map(toApprovalListItem));
    },

    // === maker ===================================================================================
    [WIDGET_KEY.KPI_MY_DRAFTS]: async (actor) =>
      toKpiWidgetData(
        await this.scoped.count(TenantCampaign, {
          where: { status: CAMPAIGN_STATUS.DRAFT, createdBy: actorRefText(actor) },
        }),
      ),
    [WIDGET_KEY.KPI_MY_PENDING]: async (actor) =>
      toKpiWidgetData(
        await this.scoped.count(PortalApprovalRequest, {
          where: { status: APPROVAL_STATUS.PENDING, requestedBy: actorRefId(actor) },
        }),
      ),
    // `reject` and `return` both leave the campaign row itself on `draft`
    // (`campaign-state-machine.ts`'s own header) — the approval request's `status` is the only
    // column that still distinguishes "rejected" from "sent back for rework", so both this and
    // `list_returned_for_rework` below read `PortalApprovalRequest`, not `TenantCampaign`.
    [WIDGET_KEY.KPI_MY_REJECTED]: async (actor) =>
      toKpiWidgetData(
        await this.scoped.count(PortalApprovalRequest, {
          where: { status: APPROVAL_STATUS.REJECTED, requestedBy: actorRefId(actor) },
        }),
      ),
    [WIDGET_KEY.LIST_MY_CAMPAIGNS]: async (actor) => {
      const rows = await this.scoped.listAll(TenantCampaign, {
        where: { createdBy: actorRefText(actor) },
        order: [['updatedAt', 'DESC']],
        limit: DASHBOARD_LIST_LIMIT,
      });
      return toListWidgetData(rows.map(toCampaignListItem));
    },
    [WIDGET_KEY.LIST_RETURNED_FOR_REWORK]: async (actor) => {
      const rows = await this.scoped.listAll(PortalApprovalRequest, {
        where: { status: APPROVAL_STATUS.RETURNED, requestedBy: actorRefId(actor) },
        order: [['reviewedAt', 'DESC']],
        limit: DASHBOARD_LIST_LIMIT,
      });
      return toListWidgetData(rows.map(toApprovalListItem));
    },

    // === checker =================================================================================
    // Segregation of duty (`approvals.service.ts`'s own headline rule): a checker never decides —
    // and, read here, never counts as "to review" — their own submission. `requestedBy !=
    // actor.userId` on top of the tenant scope `PortalApprovalRequest` already applies.
    [WIDGET_KEY.KPI_PENDING_MY_REVIEW]: async (actor) =>
      toKpiWidgetData(
        await this.scoped.count(PortalApprovalRequest, {
          where: {
            status: APPROVAL_STATUS.PENDING,
            requestedBy: { [Op.ne]: actorRefId(actor) },
          },
        }),
      ),
    [WIDGET_KEY.KPI_APPROVED_TODAY]: async (actor) =>
      toKpiWidgetData(
        await this.scoped.count(PortalApprovalRequest, {
          where: {
            status: APPROVAL_STATUS.APPROVED,
            reviewedBy: actorRefId(actor),
            reviewedAt: { [Op.gte]: startOfTodayUtc() },
          },
        }),
      ),
    [WIDGET_KEY.LIST_APPROVAL_QUEUE]: async (actor) => {
      const rows = await this.scoped.listAll(PortalApprovalRequest, {
        where: {
          status: APPROVAL_STATUS.PENDING,
          requestedBy: { [Op.ne]: actorRefId(actor) },
        },
        order: [['requestedAt', 'ASC']],
        limit: DASHBOARD_LIST_LIMIT,
      });
      return toListWidgetData(rows.map(toApprovalListItem));
    },

    // === merchant ================================================================================
    // Reused wholesale from `MerchantPortalService#getSummary` — see this file's own header.
    [WIDGET_KEY.KPI_MY_ACTIVITIES]: async (actor) =>
      toKpiWidgetData((await this.merchantPortal.getSummary(actor)).myActivitiesCount),
    [WIDGET_KEY.CHART_CAMPAIGN_PERFORMANCE]: async (actor) => {
      const { campaignPerformance } = await this.merchantPortal.getSummary(actor);
      // `MerchantCampaignPerformanceDto` is itself a discriminated union anticipating a future
      // real data source (`available: true` carries a `series`); today it is always `false`
      // (this file's own header, and `merchant-campaign-response.dto.ts`'s own TC-19 comment) —
      // read honestly here rather than assumed, so the day a data source lands this line needs
      // no change at all.
      return toChartWidgetData(campaignPerformance.available ? campaignPerformance.series : []);
    },
  };

  // --- multi-query resolvers, extracted for readability -----------------------------------------

  /**
   * `chart_campaigns_by_country` (super_admin only). Three unrestricted reads
   * (`Country`/`Tenant`/`TenantCampaign` are all globally visible to `super_admin` —
   * `scope-strategy.ts`'s own short-circuit for that role) aggregated in memory rather than
   * issued as `countries.length` separate `count()` calls: `ScopedRepository.count` deliberately
   * does not accept `group` (`scoped.repository.ts`'s own header — grouped counting was never
   * added because no caller needed it before this one), and a real `GROUP BY` would need a raw
   * query this module has no sanctioned path to (R2). At the scale a country list realistically
   * reaches (tens, not thousands — `01-DATABASE.md` names no upper bound but every seed and every
   * design doc example is single digits to low tens), three whole-table reads are cheaper than N
   * round trips and cost nothing R2 would object to.
   */
  private async chartCampaignsByCountry(): Promise<WidgetData> {
    const [countries, tenants, campaigns] = await Promise.all([
      this.scoped.listAll(Country, { order: [['name', 'ASC']] }),
      this.scoped.listAll(Tenant, { attributes: ['id', 'countryId'] }),
      this.scoped.listAll(TenantCampaign, {
        where: { status: { [Op.ne]: CAMPAIGN_STATUS.ARCHIVED } },
        attributes: ['tenantId'],
      }),
    ]);

    const countryIdOfTenant = new Map(tenants.map((tenant) => [tenant.id, tenant.countryId]));
    const countByCountryId = new Map<number, number>();
    for (const campaign of campaigns) {
      const countryId = countryIdOfTenant.get(campaign.tenantId);
      if (countryId === undefined) continue;
      countByCountryId.set(countryId, (countByCountryId.get(countryId) ?? 0) + 1);
    }

    return toChartWidgetData(
      countries.map((country) => ({
        label: country.name,
        value: countByCountryId.get(country.id) ?? 0,
      })),
    );
  }

  /** `list_recent_admin_activity` (super_admin only) — the newest `DASHBOARD_LIST_LIMIT` rows of
   * `portal_audit_log` (`PortalAuditLog`'s own header: "authentication and access-control events
   * only"). Unrestricted for `super_admin`, the only role this widget is ever seeded for. */
  private async listRecentAdminActivity(): Promise<WidgetData> {
    const rows = await this.scoped.listAll(PortalAuditLog, {
      order: [['occurredAt', 'DESC']],
      limit: DASHBOARD_LIST_LIMIT,
    });
    return toListWidgetData(
      rows.map((row) => ({
        id: row.id,
        primary: humaniseEventType(row.eventType),
        secondary: [row.actorRole, row.targetType].filter(Boolean).join(' · ') || undefined,
      })),
    );
  }

  /** `list_recent_tenants` (country_admin) — the newest `DASHBOARD_LIST_LIMIT` tenants in this
   * actor's own country (`Tenant`'s `country` scope rule already narrows this). */
  private async listRecentTenants(): Promise<WidgetData> {
    const rows = await this.scoped.listAll(Tenant, {
      order: [['createdAt', 'DESC']],
      limit: DASHBOARD_LIST_LIMIT,
    });
    return toListWidgetData(
      rows.map((tenant) => ({ id: tenant.id, primary: tenant.name, secondary: tenant.code })),
    );
  }
}

/** `list_pending_approvals` / `list_returned_for_rework` / `list_approval_queue` share this row
 * shape: no per-row campaign name is stored on `portal_approval_requests` itself (`entityId` is
 * the campaign's numeric id, not its name), so the primary line names the entity generically and
 * the secondary line carries the timestamp a reviewer actually needs to triage by. */
function toApprovalListItem(row: PortalApprovalRequest): {
  id: number;
  primary: string;
  secondary: string;
} {
  return {
    id: row.id,
    primary: `${humaniseEntityType(row.entityType)} #${row.entityId ?? row.id}`,
    secondary: row.reviewedAt
      ? `Reviewed ${row.reviewedAt.toISOString()}`
      : `Requested ${row.requestedAt.toISOString()}`,
  };
}

function toCampaignListItem(row: TenantCampaign): {
  id: number;
  primary: string;
  secondary: string;
} {
  return { id: row.id, primary: row.name, secondary: humaniseStatus(row.status) };
}

function humaniseEventType(eventType: string): string {
  return eventType.replace(/_/g, ' ');
}

function humaniseEntityType(entityType: string): string {
  return entityType.charAt(0).toUpperCase() + entityType.slice(1).replace(/_/g, ' ');
}

function humaniseStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

/** Midnight UTC of the current day — the boundary `kpi_approved_today` counts against. UTC
 * rather than a per-tenant timezone: `portal_users.preferred_timezone` is a display preference
 * (`portal-user.model.ts`), never plumbed into any query anywhere else in this codebase either. */
function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
