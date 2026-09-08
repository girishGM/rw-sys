/**
 * T-INT-030 — `RewardTrackingDashboardController` in isolation, its three collaborators mocked.
 * Evidences TC-6 (a resolved GRPC primary fails closed, no silent REST reroute) and that every
 * RTS rejection propagates untouched (TC-4's unit-level twin) — the live-RTS half of TC-1/2/3/4/7
 * runs against a real, locally running RTS instance per this task's own Verification steps.
 */
import type { RewardTrackingAdminTokenService } from '@/modules/reward-tracking-integration/reward-tracking-admin-token';
import type {
  RewardTrackingChannelResolverService,
  ResolvedRewardTrackingChannel,
} from '@/modules/reward-tracking-integration/reward-tracking-channel-resolver.service';
import {
  RewardTrackingGrpcNotAvailableError,
  RewardTrackingRestClient,
  RewardTrackingUpstreamRejectionError,
} from '@/modules/reward-tracking-integration/reward-tracking-rest.client';
import { RewardTrackingDashboardController } from '@/modules/reward-tracking-integration/reward-tracking-dashboard.controller';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';

const TENANT_ADMIN: AuthenticatedUser = {
  userId: 1,
  sessionId: 'sess-1',
  role: 'tenant_admin',
  countryId: 5,
  tenantId: 7,
  merchantId: null,
  rbacVersion: 1,
  tokenId: 'tok-1',
  mustChangePassword: false,
};

const REST_PRIMARY: ResolvedRewardTrackingChannel = {
  primaryChannel: 'REST',
  fallbackChannel: 'REST',
  restEnabled: true,
  grpcEnabled: false,
};

const GRPC_PRIMARY: ResolvedRewardTrackingChannel = {
  primaryChannel: 'GRPC',
  fallbackChannel: 'REST',
  restEnabled: true,
  grpcEnabled: false,
};

function build(resolved: ResolvedRewardTrackingChannel) {
  const tokens = {
    mint: jest.fn().mockReturnValue('minted-token'),
  } as unknown as RewardTrackingAdminTokenService;
  const resolver = {
    resolve: jest.fn().mockResolvedValue(resolved),
  } as unknown as RewardTrackingChannelResolverService;
  const client = {
    getCampaignSummary: jest.fn().mockResolvedValue({ campaignCode: 'C1', totals: [] }),
    getMerchantSummary: jest.fn().mockResolvedValue({ merchantCode: 'M1', totals: [] }),
    getTenantSummary: jest.fn().mockResolvedValue({ tenantId: 7, totals: [] }),
    getCountrySummary: jest.fn().mockResolvedValue({ countryCode: 'MY', totals: [] }),
    getAlerts: jest.fn().mockResolvedValue({ alerts: [] }),
  } as unknown as RewardTrackingRestClient;

  const controller = new RewardTrackingDashboardController(tokens, resolver, client);
  return { controller, tokens, resolver, client };
}

describe('T-INT-030 — RewardTrackingDashboardController', () => {
  it('TC-6: a resolved GRPC primary fails closed with RewardTrackingGrpcNotAvailableError — the REST client is never called', async () => {
    const { controller, client } = build(GRPC_PRIMARY);

    await expect(controller.getAlerts(TENANT_ADMIN)).rejects.toBeInstanceOf(
      RewardTrackingGrpcNotAvailableError,
    );
    expect(client.getAlerts).not.toHaveBeenCalled();
  });

  it('a REST-primary resolution mints a token and calls the REST client with it', async () => {
    const { controller, tokens, client } = build(REST_PRIMARY);

    await controller.getCampaignSummary(TENANT_ADMIN, 'CAMP-1');

    expect(tokens.mint).toHaveBeenCalledWith(TENANT_ADMIN);
    expect(client.getCampaignSummary).toHaveBeenCalledWith('CAMP-1', 'minted-token');
  });

  it("getCampaignSummary passes the caller's own tenantId as resolver context, not the path param", async () => {
    const { controller, resolver } = build(REST_PRIMARY);

    await controller.getCampaignSummary(TENANT_ADMIN, 'CAMP-1');

    expect(resolver.resolve).toHaveBeenCalledWith({ campaignCode: 'CAMP-1', tenantId: 7 });
  });

  it('getTenantSummary forwards the path tenantId to the REST client — RTS itself decides whether the claim authorises it (TC-4)', async () => {
    const { controller, client } = build(REST_PRIMARY);

    await controller.getTenantSummary(TENANT_ADMIN, 99);

    expect(client.getTenantSummary).toHaveBeenCalledWith(99, 'minted-token');
  });

  it('TC-4 (unit twin): a RewardTrackingUpstreamRejectionError thrown by the REST client propagates untouched, with the same status', async () => {
    const { controller, client } = build(REST_PRIMARY);
    (client.getAlerts as jest.Mock).mockRejectedValue(
      new RewardTrackingUpstreamRejectionError(403, { logMessage: 'scope mismatch' }),
    );

    await expect(controller.getAlerts(TENANT_ADMIN)).rejects.toMatchObject({ status: 403 });
  });

  it('TC-7: alerts returns an empty array untouched, not an error', async () => {
    const { controller } = build(REST_PRIMARY);

    const result = await controller.getAlerts(TENANT_ADMIN);

    expect(result).toEqual({ alerts: [] });
  });

  it('getCountrySummary resolves with no campaignCode/tenantId context — RTS alone decides country-level authorisation', async () => {
    const { controller, resolver } = build(REST_PRIMARY);

    await controller.getCountrySummary(TENANT_ADMIN, 'MY');

    expect(resolver.resolve).toHaveBeenCalledWith({});
  });

  it('a super_admin (null tenantId claim) still resolves via GLOBAL context for alerts', async () => {
    const superAdmin: AuthenticatedUser = {
      ...TENANT_ADMIN,
      role: 'super_admin',
      tenantId: null,
      countryId: null,
    };
    const { controller, resolver } = build(REST_PRIMARY);

    await controller.getAlerts(superAdmin);

    expect(resolver.resolve).toHaveBeenCalledWith({ tenantId: undefined });
  });
});
