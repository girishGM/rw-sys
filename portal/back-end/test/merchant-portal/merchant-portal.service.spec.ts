/**
 * T-039 — `MerchantPortalService`: `listCampaigns`, `getCampaign`, `getSummary`.
 *
 * The property under test throughout is *"which decision was made, and on what basis"* — the
 * real cross-tenant/cross-merchant isolation is `ScopedRepository`'s/`scope-strategy.ts`'s to
 * prove (T-013, 100% branch coverage there already) and `merchant-portal.e2e-spec.ts` proves it
 * for real against the live database (TC-2's own headline claim). Negative-authorisation
 * (R6, TC-16) is proven directly here at the service layer — `assertRole`'s own third,
 * independent layer — rather than only inferred from controller metadata.
 */
import { Activity } from '@/database/models/activity.model';
import { CampaignMerchant } from '@/database/models/campaign-merchant.model';
import { MerchantActivity } from '@/database/models/merchant-activity.model';
import { TenantCampaign } from '@/database/models/tenant-campaign.model';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import { MerchantPortalService } from '@/modules/merchant-portal/merchant-portal.service';
import {
  FakeScopedRepository,
  activityRow,
  actor,
  asScopedRepository,
  campaignMerchantRow,
  campaignRow,
  merchantActivityRow,
} from './support/merchant-portal-doubles';

describe('MerchantPortalService', () => {
  let scoped: FakeScopedRepository;
  let service: MerchantPortalService;

  beforeEach(() => {
    scoped = new FakeScopedRepository();
    service = new MerchantPortalService(asScopedRepository(scoped));
  });

  describe('assertRole — every method (TC-16)', () => {
    it.each(['listCampaigns', 'getCampaign', 'getSummary'] as const)(
      '%s rejects a non-merchant caller with 403, before any query runs',
      async (method) => {
        const nonMerchant = actor({ role: 'maker' });

        const call =
          method === 'getCampaign'
            ? service.getCampaign(nonMerchant, 1)
            : method === 'listCampaigns'
              ? service.listCampaigns(nonMerchant)
              : service.getSummary(nonMerchant);

        await expect(call).rejects.toBeInstanceOf(PermissionDeniedHttpException);
        expect(scoped.calls).toHaveLength(0);
      },
    );
  });

  describe('listCampaigns', () => {
    it('lists only status-filtered, scoped campaigns, newest-start-date first', async () => {
      const active = campaignRow({ id: 1, status: 'active' });
      scoped.setListRows(TenantCampaign, [active]);

      const result = await service.listCampaigns(actor());

      expect(result).toEqual([
        expect.objectContaining({ id: 1, campaignCode: 'CMP-1', status: 'active' }),
      ]);
      const call = scoped.callsTo('listAll')[0];
      expect(call.model).toBe('TenantCampaign');
      const options = call.options as {
        where: { status: Record<symbol, string[]> };
        order: unknown;
      };
      expect(options.where.status).toBeDefined();
      expect(options.order).toEqual([
        ['startDate', 'DESC'],
        ['id', 'DESC'],
      ]);
    });

    it('TC-17 — an empty participation returns an empty array, not an error', async () => {
      scoped.setListRows(TenantCampaign, []);
      await expect(service.listCampaigns(actor())).resolves.toEqual([]);
    });
  });

  describe('getCampaign', () => {
    it('assembles the header, this merchant’s own participation and its own activities (TC-8/TC-9)', async () => {
      scoped.setByPk(TenantCampaign, campaignRow({ id: 1 }));
      scoped.setByOne(CampaignMerchant, campaignMerchantRow({ campaignId: 1 }));
      scoped.setListRows(MerchantActivity, [merchantActivityRow({ activityId: 50 })]);
      scoped.setListRows(Activity, [activityRow({ id: 50, name: 'In-store purchase' })]);

      const result = await service.getCampaign(actor(), 1);

      expect(result).toEqual({
        id: 1,
        campaignCode: 'CMP-1',
        name: 'Summer Splash',
        description: null,
        region: 'EU',
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-02-01T00:00:00.000Z',
        status: 'active',
        maxParticipants: 5,
        participation: { status: 'active', joinedAt: '2026-01-05T00:00:00.000Z' },
        myActivities: [
          {
            activityId: 50,
            activityName: 'In-store purchase',
            storeId: null,
            commissionRate: '2.50',
          },
        ],
      });
      // Never the campaign's internal budget (implementation note 2) — asserted directly, not
      // merely inferred from the DTO type, so a future edit that widens the object literal above
      // fails this test immediately rather than silently leaking it.
      expect(result).not.toHaveProperty('budgetAmount');
      expect(result).not.toHaveProperty('budgetCurrency');
      expect(result).not.toHaveProperty('tenantId');
    });

    it('TC-3/TC-4/TC-5/TC-6 — a missing, out-of-scope, or wrong-status campaign 404s', async () => {
      scoped.setByPk(TenantCampaign, null);
      await expect(service.getCampaign(actor(), 999)).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it('scopes the campaign lookup to the merchant-visible statuses only (TC-5/TC-6)', async () => {
      scoped.setByPk(TenantCampaign, campaignRow({ id: 1 }));
      scoped.setByOne(CampaignMerchant, campaignMerchantRow({ campaignId: 1 }));
      scoped.setListRows(MerchantActivity, []);

      await service.getCampaign(actor(), 1);

      const call = scoped.callsTo('findByPkOrFail')[0];
      const options = call.options as { where: { status: Record<symbol, string[]> } };
      const inClause = Object.getOwnPropertySymbols(options.where.status)[0];
      expect((options.where.status as Record<symbol, string[]>)[inClause]).toEqual([
        'active',
        'paused',
        'completed',
      ]);
    });

    it('an empty `myActivities` short-circuits without a second query for `Activity` names', async () => {
      scoped.setByPk(TenantCampaign, campaignRow({ id: 1 }));
      scoped.setByOne(CampaignMerchant, campaignMerchantRow({ campaignId: 1 }));
      scoped.setListRows(MerchantActivity, []);

      const result = await service.getCampaign(actor(), 1);

      expect(result.myActivities).toEqual([]);
      expect(scoped.callsTo('listAll').some((call) => call.model === 'Activity')).toBe(false);
    });

    it('falls back to "Unknown activity" when the linked activity row cannot be found', async () => {
      scoped.setByPk(TenantCampaign, campaignRow({ id: 1 }));
      scoped.setByOne(CampaignMerchant, campaignMerchantRow({ campaignId: 1 }));
      scoped.setListRows(MerchantActivity, [merchantActivityRow({ activityId: 999 })]);
      scoped.setListRows(Activity, []);

      const result = await service.getCampaign(actor(), 1);

      expect(result.myActivities[0].activityName).toBe('Unknown activity');
    });

    it('de-duplicates activity ids before looking their names up', async () => {
      scoped.setByPk(TenantCampaign, campaignRow({ id: 1 }));
      scoped.setByOne(CampaignMerchant, campaignMerchantRow({ campaignId: 1 }));
      scoped.setListRows(MerchantActivity, [
        merchantActivityRow({ id: 301, activityId: 50, storeId: 1 }),
        merchantActivityRow({ id: 302, activityId: 50, storeId: 2 }),
      ]);
      scoped.setListRows(Activity, [activityRow({ id: 50, name: 'In-store purchase' })]);

      const result = await service.getCampaign(actor(), 1);

      expect(result.myActivities).toHaveLength(2);
      const activityCall = scoped.callsTo('listAll').find((call) => call.model === 'Activity');
      const options = activityCall?.options as { where: { id: Record<symbol, number[]> } };
      const inClause = Object.getOwnPropertySymbols(options.where.id)[0];
      expect((options.where.id as Record<symbol, number[]>)[inClause]).toEqual([50]);
    });
  });

  describe('getSummary', () => {
    it('TC-13/TC-18 — counts active campaigns and own activities, and lists participating campaigns', async () => {
      scoped.setListRows(TenantCampaign, [
        campaignRow({ id: 1, status: 'active' }),
        campaignRow({ id: 2, status: 'paused' }),
      ]);
      scoped.setListRows(MerchantActivity, [merchantActivityRow()]);

      const result = await service.getSummary(actor());

      expect(result.activeCampaignsCount).toBe(1);
      expect(result.myActivitiesCount).toBe(1);
      expect(result.participatingCampaigns).toHaveLength(2);
    });

    it('TC-19 — an honest "not available" performance state, never a fabricated number', async () => {
      scoped.setListRows(TenantCampaign, []);
      scoped.setListRows(MerchantActivity, []);

      const result = await service.getSummary(actor());

      expect(result.campaignPerformance).toEqual({
        available: false,
        reason: expect.stringContaining('No redemption or transaction data source'),
      });
    });
  });
});
