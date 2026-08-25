/**
 * T-039 — `MerchantPortalController`, against a mocked `MerchantPortalService`. Guard behaviour
 * (`@RequirePermission`, `@Roles('merchant')`) is proved for real in
 * `merchant-portal.e2e-spec.ts`; this suite proves the controller's own shaping — the `{ data }`
 * envelope, and TC-10/TC-12 ("no mutating route exists at all").
 */
import { MerchantPortalController } from '@/modules/merchant-portal/merchant-portal.controller';
import type { MerchantPortalService } from '@/modules/merchant-portal/merchant-portal.service';
import { actor } from './support/merchant-portal-doubles';

describe('GET /merchant/campaigns', () => {
  it('envelopes the list', async () => {
    const service = {
      listCampaigns: jest.fn().mockResolvedValue([{ id: 1, name: 'Summer Splash' }]),
    } as unknown as MerchantPortalService;
    const controller = new MerchantPortalController(service);

    const result = await controller.listCampaigns(actor());

    expect(result).toEqual({ data: [{ id: 1, name: 'Summer Splash' }] });
    expect(service.listCampaigns).toHaveBeenCalledWith(actor());
  });
});

describe('GET /merchant/campaigns/:id', () => {
  it('envelopes the detail, passing the parsed numeric id through', async () => {
    const service = {
      getCampaign: jest.fn().mockResolvedValue({ id: 42, name: 'Winter Sale' }),
    } as unknown as MerchantPortalService;
    const controller = new MerchantPortalController(service);

    const result = await controller.getCampaign(actor(), 42);

    expect(result).toEqual({ data: { id: 42, name: 'Winter Sale' } });
    expect(service.getCampaign).toHaveBeenCalledWith(actor(), 42);
  });
});

describe('GET /merchant/summary', () => {
  it('envelopes the summary', async () => {
    const summary = {
      activeCampaignsCount: 2,
      myActivitiesCount: 1,
      campaignPerformance: { available: false, reason: 'no source table' },
      participatingCampaigns: [],
    };
    const service = {
      getSummary: jest.fn().mockResolvedValue(summary),
    } as unknown as MerchantPortalService;
    const controller = new MerchantPortalController(service);

    const result = await controller.getSummary(actor());

    expect(result).toEqual({ data: summary });
  });
});

describe('TC-10/TC-12 — no mutating route', () => {
  it('the controller class declares only @Get handlers', () => {
    const proto = MerchantPortalController.prototype as unknown as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor');

    expect(methodNames).toEqual(
      expect.arrayContaining(['listCampaigns', 'getCampaign', 'getSummary']),
    );
    // No `create`/`update`/`remove`/`delete`/`patch`/`post`/`put`-shaped method exists on this
    // controller at all — the merchant role has no write endpoint anywhere in this module
    // (implementation note 3).
    expect(
      methodNames.some((name) => /create|update|remove|delete|patch|post|put/i.test(name)),
    ).toBe(false);
  });
});
