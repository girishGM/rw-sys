/**
 * T-092 — `DashboardService#getWidgetData`: the gate, and every resolver's query shape and
 * mapping. Real cross-tenant/cross-role isolation is `ScopedRepository`'s to prove (T-013, 100%
 * branch coverage already) and `dashboard.e2e-spec.ts` proves it for real against the live
 * database (TC-1/TC-2/TC-3, the regression this whole task exists to fix). This suite proves
 * *which* query each resolver issues and *what* it does with the result.
 */
import { NotFoundError } from '@/common/errors/app-error';
import { Country, Merchant, RoleDashboardWidget, Tenant, TenantCampaign } from '@/database/models';
import { PortalApprovalRequest, PortalAuditLog, PortalUser } from '@/database/portal-models';
import { DashboardService } from '@/modules/dashboard/dashboard.service';
import { WIDGET_KEY } from '@/modules/dashboard/dashboard.constants';
import type { MerchantPortalService } from '@/modules/merchant-portal/merchant-portal.service';
import type { TenantsService } from '@/modules/tenants/tenants.service';
import { actor, asScopedRepository, FakeScopedRepository } from './support/dashboard-doubles';

function tenantsServiceStub(overrides: Partial<TenantsService> = {}): TenantsService {
  return {
    listTenantsWithoutCeiling: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TenantsService;
}

function merchantPortalServiceStub(
  overrides: Partial<MerchantPortalService> = {},
): MerchantPortalService {
  return {
    getSummary: jest.fn().mockResolvedValue({
      activeCampaignsCount: 0,
      myActivitiesCount: 0,
      campaignPerformance: { available: false, reason: 'none' },
      participatingCampaigns: [],
    }),
    ...overrides,
  } as unknown as MerchantPortalService;
}

describe('DashboardService', () => {
  let scoped: FakeScopedRepository;
  let tenants: TenantsService;
  let merchantPortal: MerchantPortalService;
  let service: DashboardService;

  beforeEach(() => {
    scoped = new FakeScopedRepository();
    tenants = tenantsServiceStub();
    merchantPortal = merchantPortalServiceStub();
    service = new DashboardService(asScopedRepository(scoped), tenants, merchantPortal);
    // Assigned by default; individual tests override with `setCount(RoleDashboardWidget, 0)`.
    scoped.setCount(RoleDashboardWidget, 1);
  });

  describe('the assignment gate', () => {
    it('TC-1/TC-2 — a widget not assigned/enabled for this role 404s before any resolver runs', async () => {
      scoped.setCount(RoleDashboardWidget, 0);

      await expect(
        service.getWidgetData(actor({ role: 'checker' }), WIDGET_KEY.KPI_COUNTRIES),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(scoped.callsTo('count', 'Country')).toHaveLength(0);
    });

    it('checks role_dashboard_widgets for this actor role + widgetKey + enabled=true', async () => {
      scoped.setCount(Country, 3);
      await service.getWidgetData(actor({ role: 'super_admin' }), WIDGET_KEY.KPI_COUNTRIES);

      const call = scoped.callsTo('count', 'RoleDashboardWidget')[0];
      expect(call.options).toMatchObject({
        where: { role: 'super_admin', widgetKey: WIDGET_KEY.KPI_COUNTRIES, enabled: true },
      });
    });

    it('an unknown widgetKey with a matching seed row somehow present still 404s (no resolver registered)', async () => {
      await expect(service.getWidgetData(actor(), 'not_a_real_widget_key')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('super_admin widgets', () => {
    it('kpi_countries counts Country unrestricted', async () => {
      scoped.setCount(Country, 7);
      const result = await service.getWidgetData(actor(), WIDGET_KEY.KPI_COUNTRIES);
      expect(result).toEqual({ value: 7 });
    });

    it('kpi_tenants counts Tenant', async () => {
      scoped.setCount(Tenant, 12);
      const result = await service.getWidgetData(actor(), WIDGET_KEY.KPI_TENANTS);
      expect(result).toEqual({ value: 12 });
    });

    it('kpi_active_campaigns counts TenantCampaign where status=active', async () => {
      scoped.setCount(TenantCampaign, 4);
      const result = await service.getWidgetData(actor(), WIDGET_KEY.KPI_ACTIVE_CAMPAIGNS);
      expect(result).toEqual({ value: 4 });
      expect(scoped.callsTo('count', 'TenantCampaign')[0].options).toMatchObject({
        where: { status: 'active' },
      });
    });

    it('chart_campaigns_by_country aggregates campaigns per country in memory', async () => {
      scoped.setListRows(Country, [
        { id: 1, name: 'Alpha' },
        { id: 2, name: 'Beta' },
      ]);
      scoped.setListRows(Tenant, [
        { id: 10, countryId: 1 },
        { id: 20, countryId: 2 },
        { id: 21, countryId: 2 },
      ]);
      scoped.setListRows(TenantCampaign, [
        { tenantId: 10 },
        { tenantId: 20 },
        { tenantId: 21 },
        { tenantId: 21 },
      ]);

      const result = await service.getWidgetData(actor(), WIDGET_KEY.CHART_CAMPAIGNS_BY_COUNTRY);

      expect(result).toEqual({
        series: [
          { label: 'Alpha', value: 1 },
          { label: 'Beta', value: 3 },
        ],
      });
    });

    it('chart_campaigns_by_country excludes archived campaigns from the count', async () => {
      scoped.setListRows(Country, [{ id: 1, name: 'Alpha' }]);
      scoped.setListRows(Tenant, [{ id: 10, countryId: 1 }]);
      await service.getWidgetData(actor(), WIDGET_KEY.CHART_CAMPAIGNS_BY_COUNTRY);

      const call = scoped.callsTo('listAll', 'TenantCampaign')[0];
      const options = call.options as { where: { status: Record<symbol, string> } };
      const neSymbol = Object.getOwnPropertySymbols(options.where.status)[0];
      expect((options.where.status as Record<symbol, string>)[neSymbol]).toBe('archived');
    });

    it('chart_campaigns_by_country ignores a campaign whose tenant is not in the country map', async () => {
      scoped.setListRows(Country, [{ id: 1, name: 'Alpha' }]);
      scoped.setListRows(Tenant, [{ id: 10, countryId: 1 }]);
      scoped.setListRows(TenantCampaign, [{ tenantId: 999 }]);

      const result = await service.getWidgetData(actor(), WIDGET_KEY.CHART_CAMPAIGNS_BY_COUNTRY);
      expect(result).toEqual({ series: [{ label: 'Alpha', value: 0 }] });
    });

    it('list_recent_admin_activity lists the newest portal_audit_log rows', async () => {
      scoped.setListRows(PortalAuditLog, [
        {
          id: '1',
          eventType: 'login_success',
          actorRole: 'super_admin',
          targetType: null,
          occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);

      const result = await service.getWidgetData(actor(), WIDGET_KEY.LIST_RECENT_ADMIN_ACTIVITY);

      expect(result).toEqual({
        items: [{ id: '1', primary: 'login success', secondary: 'super_admin' }],
      });
      const call = scoped.callsTo('listAll', 'PortalAuditLog')[0];
      expect(call.options).toMatchObject({
        order: [['occurredAt', 'DESC']],
        limit: 10,
      });
    });

    it('list_recent_admin_activity omits `secondary` when the row carries neither actorRole nor targetType', async () => {
      scoped.setListRows(PortalAuditLog, [
        {
          id: '2',
          eventType: 'system_startup',
          actorRole: null,
          targetType: null,
          occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);

      const result = await service.getWidgetData(actor(), WIDGET_KEY.LIST_RECENT_ADMIN_ACTIVITY);

      expect(result).toEqual({
        items: [{ id: '2', primary: 'system startup', secondary: undefined }],
      });
    });
  });

  describe('country_admin widgets', () => {
    it('kpi_pending_approvals counts PortalApprovalRequest where status=pending', async () => {
      scoped.setCount(PortalApprovalRequest, 5);
      const result = await service.getWidgetData(
        actor({ role: 'country_admin', countryId: 1, tenantId: null }),
        WIDGET_KEY.KPI_PENDING_APPROVALS,
      );
      expect(result).toEqual({ value: 5 });
      expect(scoped.callsTo('count', 'PortalApprovalRequest')[0].options).toMatchObject({
        where: { status: 'pending' },
      });
    });

    it('list_recent_tenants lists the newest tenants', async () => {
      scoped.setListRows(Tenant, [{ id: 1, name: 'Acme', code: 'ACM' }]);
      const result = await service.getWidgetData(
        actor({ role: 'country_admin' }),
        WIDGET_KEY.LIST_RECENT_TENANTS,
      );
      expect(result).toEqual({ items: [{ id: 1, primary: 'Acme', secondary: 'ACM' }] });
      expect(scoped.callsTo('listAll', 'Tenant')[0].options).toMatchObject({
        order: [['createdAt', 'DESC']],
        limit: 10,
      });
    });

    it('list_tenants_without_ceiling delegates to TenantsService#listTenantsWithoutCeiling (reuse, not re-derivation)', async () => {
      tenants = tenantsServiceStub({
        listTenantsWithoutCeiling: jest
          .fn()
          .mockResolvedValue([{ id: 3, code: 'GAP', name: 'Gap Co', countryId: 1 }]),
      });
      service = new DashboardService(asScopedRepository(scoped), tenants, merchantPortal);

      const result = await service.getWidgetData(
        actor({ role: 'country_admin' }),
        WIDGET_KEY.LIST_TENANTS_WITHOUT_CEILING,
      );

      expect(tenants.listTenantsWithoutCeiling).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ items: [{ id: 3, primary: 'Gap Co', secondary: 'GAP' }] });
    });
  });

  describe('tenant_admin widgets', () => {
    it('kpi_users counts active PortalUser rows', async () => {
      scoped.setCount(PortalUser, 9);
      const result = await service.getWidgetData(
        actor({ role: 'tenant_admin' }),
        WIDGET_KEY.KPI_USERS,
      );
      expect(result).toEqual({ value: 9 });
      expect(scoped.callsTo('count', 'PortalUser')[0].options).toMatchObject({
        where: { status: 'active' },
      });
    });

    it('kpi_merchants counts active Merchant rows', async () => {
      scoped.setCount(Merchant, 2);
      const result = await service.getWidgetData(
        actor({ role: 'tenant_admin' }),
        WIDGET_KEY.KPI_MERCHANTS,
      );
      expect(result).toEqual({ value: 2 });
      expect(scoped.callsTo('count', 'Merchant')[0].options).toMatchObject({
        where: { status: 'active' },
      });
    });

    it('kpi_campaigns_by_status counts every non-archived campaign', async () => {
      scoped.setCount(TenantCampaign, 6);
      const result = await service.getWidgetData(
        actor({ role: 'tenant_admin' }),
        WIDGET_KEY.KPI_CAMPAIGNS_BY_STATUS,
      );
      expect(result).toEqual({ value: 6 });
      const options = scoped.callsTo('count', 'TenantCampaign')[0].options as {
        where: { status: Record<symbol, string> };
      };
      const neSymbol = Object.getOwnPropertySymbols(options.where.status)[0];
      expect((options.where.status as Record<symbol, string>)[neSymbol]).toBe('archived');
    });

    it('list_pending_approvals lists the oldest-first pending queue', async () => {
      scoped.setListRows(PortalApprovalRequest, [
        {
          id: 1,
          entityType: 'campaign',
          entityId: 55,
          requestedAt: new Date('2026-01-01T00:00:00.000Z'),
          reviewedAt: null,
        },
      ]);
      const result = await service.getWidgetData(
        actor({ role: 'tenant_admin' }),
        WIDGET_KEY.LIST_PENDING_APPROVALS,
      );
      expect(result).toEqual({
        items: [
          { id: 1, primary: 'Campaign #55', secondary: 'Requested 2026-01-01T00:00:00.000Z' },
        ],
      });
      expect(scoped.callsTo('listAll', 'PortalApprovalRequest')[0].options).toMatchObject({
        where: { status: 'pending' },
        order: [['requestedAt', 'ASC']],
        limit: 10,
      });
    });
  });

  describe('maker widgets', () => {
    const maker = actor({ role: 'maker', userId: 900, tenantId: 10 });

    it('kpi_my_drafts counts this maker’s own draft campaigns (createdBy = String(userId))', async () => {
      scoped.setCount(TenantCampaign, 3);
      const result = await service.getWidgetData(maker, WIDGET_KEY.KPI_MY_DRAFTS);
      expect(result).toEqual({ value: 3 });
      expect(scoped.callsTo('count', 'TenantCampaign')[0].options).toMatchObject({
        where: { status: 'draft', createdBy: '900' },
      });
    });

    it('kpi_my_pending counts this maker’s own pending approval requests', async () => {
      scoped.setCount(PortalApprovalRequest, 1);
      const result = await service.getWidgetData(maker, WIDGET_KEY.KPI_MY_PENDING);
      expect(result).toEqual({ value: 1 });
      expect(scoped.callsTo('count', 'PortalApprovalRequest')[0].options).toMatchObject({
        where: { status: 'pending', requestedBy: 900 },
      });
    });

    it('kpi_my_rejected counts rejected (not returned) approval requests, by requestedBy', async () => {
      scoped.setCount(PortalApprovalRequest, 2);
      const result = await service.getWidgetData(maker, WIDGET_KEY.KPI_MY_REJECTED);
      expect(result).toEqual({ value: 2 });
      expect(scoped.callsTo('count', 'PortalApprovalRequest')[0].options).toMatchObject({
        where: { status: 'rejected', requestedBy: 900 },
      });
    });

    it('list_my_campaigns lists every campaign this maker created, newest-updated first', async () => {
      scoped.setListRows(TenantCampaign, [
        { id: 1, name: 'Summer', status: 'draft', createdBy: '900' },
      ]);
      const result = await service.getWidgetData(maker, WIDGET_KEY.LIST_MY_CAMPAIGNS);
      expect(result).toEqual({ items: [{ id: 1, primary: 'Summer', secondary: 'draft' }] });
      expect(scoped.callsTo('listAll', 'TenantCampaign')[0].options).toMatchObject({
        where: { createdBy: '900' },
        order: [['updatedAt', 'DESC']],
        limit: 10,
      });
    });

    it('falls back to the approval request’s own id when entityId is null', async () => {
      scoped.setListRows(PortalApprovalRequest, [
        {
          id: 42,
          entityType: 'campaign',
          entityId: null,
          requestedAt: new Date('2026-01-01T00:00:00.000Z'),
          reviewedAt: null,
        },
      ]);
      const result = await service.getWidgetData(maker, WIDGET_KEY.LIST_RETURNED_FOR_REWORK);
      expect(result).toEqual({
        items: [
          { id: 42, primary: 'Campaign #42', secondary: 'Requested 2026-01-01T00:00:00.000Z' },
        ],
      });
    });

    it('list_returned_for_rework lists status=returned requests, reviewed-newest first', async () => {
      scoped.setListRows(PortalApprovalRequest, [
        {
          id: 2,
          entityType: 'campaign',
          entityId: 77,
          requestedAt: new Date('2026-01-01T00:00:00.000Z'),
          reviewedAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);
      const result = await service.getWidgetData(maker, WIDGET_KEY.LIST_RETURNED_FOR_REWORK);
      expect(result).toEqual({
        items: [{ id: 2, primary: 'Campaign #77', secondary: 'Reviewed 2026-01-02T00:00:00.000Z' }],
      });
      expect(scoped.callsTo('listAll', 'PortalApprovalRequest')[0].options).toMatchObject({
        where: { status: 'returned', requestedBy: 900 },
        order: [['reviewedAt', 'DESC']],
        limit: 10,
      });
    });
  });

  describe('checker widgets — segregation of duty', () => {
    const checker = actor({ role: 'checker', userId: 700, tenantId: 10 });

    it('kpi_pending_my_review excludes this checker’s own submissions', async () => {
      scoped.setCount(PortalApprovalRequest, 4);
      const result = await service.getWidgetData(checker, WIDGET_KEY.KPI_PENDING_MY_REVIEW);
      expect(result).toEqual({ value: 4 });
      const options = scoped.callsTo('count', 'PortalApprovalRequest')[0].options as {
        where: { status: string; requestedBy: Record<symbol, number> };
      };
      expect(options.where.status).toBe('pending');
      const neSymbol = Object.getOwnPropertySymbols(options.where.requestedBy)[0];
      expect(options.where.requestedBy[neSymbol]).toBe(700);
    });

    it('kpi_approved_today counts only this checker’s own decisions made since midnight UTC', async () => {
      scoped.setCount(PortalApprovalRequest, 1);
      const result = await service.getWidgetData(checker, WIDGET_KEY.KPI_APPROVED_TODAY);
      expect(result).toEqual({ value: 1 });
      const options = scoped.callsTo('count', 'PortalApprovalRequest')[0].options as {
        where: { status: string; reviewedBy: number; reviewedAt: Record<symbol, Date> };
      };
      expect(options.where.status).toBe('approved');
      expect(options.where.reviewedBy).toBe(700);
      const gteSymbol = Object.getOwnPropertySymbols(options.where.reviewedAt)[0];
      const boundary = options.where.reviewedAt[gteSymbol];
      expect(boundary.getUTCHours()).toBe(0);
      expect(boundary.getUTCMinutes()).toBe(0);
    });

    it('list_approval_queue excludes this checker’s own submissions, oldest first', async () => {
      scoped.setListRows(PortalApprovalRequest, [
        {
          id: 9,
          entityType: 'campaign',
          entityId: 5,
          requestedAt: new Date('2026-01-01T00:00:00.000Z'),
          reviewedAt: null,
        },
      ]);
      const result = await service.getWidgetData(checker, WIDGET_KEY.LIST_APPROVAL_QUEUE);
      expect(result).toEqual({
        items: [{ id: 9, primary: 'Campaign #5', secondary: 'Requested 2026-01-01T00:00:00.000Z' }],
      });
      const options = scoped.callsTo('listAll', 'PortalApprovalRequest')[0].options as {
        where: { status: string; requestedBy: Record<symbol, number> };
        order: unknown;
        limit: number;
      };
      expect(options.where.status).toBe('pending');
      const neSymbol = Object.getOwnPropertySymbols(options.where.requestedBy)[0];
      expect(options.where.requestedBy[neSymbol]).toBe(700);
      expect(options.order).toEqual([['requestedAt', 'ASC']]);
      expect(options.limit).toBe(10);
    });
  });

  describe('merchant widgets — reused from MerchantPortalService#getSummary', () => {
    const merchant = actor({ role: 'merchant', userId: 500, tenantId: 10, merchantId: 100 });

    it('kpi_my_activities reads myActivitiesCount', async () => {
      merchantPortal = merchantPortalServiceStub({
        getSummary: jest.fn().mockResolvedValue({
          activeCampaignsCount: 0,
          myActivitiesCount: 6,
          campaignPerformance: { available: false, reason: 'none' },
          participatingCampaigns: [],
        }),
      });
      service = new DashboardService(asScopedRepository(scoped), tenants, merchantPortal);

      const result = await service.getWidgetData(merchant, WIDGET_KEY.KPI_MY_ACTIVITIES);
      expect(result).toEqual({ value: 6 });
      expect(merchantPortal.getSummary).toHaveBeenCalledWith(merchant);
    });

    it('chart_campaign_performance returns an empty, honest series when unavailable (TC-19 shape)', async () => {
      const result = await service.getWidgetData(merchant, WIDGET_KEY.CHART_CAMPAIGN_PERFORMANCE);
      expect(result).toEqual({ series: [] });
    });

    it('chart_campaign_performance surfaces a real series the day one is available', async () => {
      merchantPortal = merchantPortalServiceStub({
        getSummary: jest.fn().mockResolvedValue({
          activeCampaignsCount: 0,
          myActivitiesCount: 0,
          campaignPerformance: {
            available: true,
            series: [{ label: 'Week 1', value: 10 }],
          },
          participatingCampaigns: [],
        }),
      });
      service = new DashboardService(asScopedRepository(scoped), tenants, merchantPortal);

      const result = await service.getWidgetData(merchant, WIDGET_KEY.CHART_CAMPAIGN_PERFORMANCE);
      expect(result).toEqual({ series: [{ label: 'Week 1', value: 10 }] });
    });
  });
});
