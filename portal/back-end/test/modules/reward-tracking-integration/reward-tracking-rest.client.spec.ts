/**
 * T-INT-030 — `RewardTrackingRestClient` in isolation, `global.fetch` mocked. Evidences TC-4
 * ("same rejection surfaces through the portal's own proxy, not swallowed into a 500") and TC-7
 * ("alerts — real data, or an empty array, never a 500") at the unit level; the same properties
 * are proven again against a real, locally running RTS instance in this task's own Verification
 * steps 2-4, since a mock can assert this file called the right URL with the right header but
 * cannot prove RTS's own guard actually accepts what was sent.
 */
import type { ConfigService } from '@nestjs/config';
import {
  RewardTrackingGrpcNotAvailableError,
  RewardTrackingRestClient,
  RewardTrackingServiceTimeoutError,
  RewardTrackingServiceUnavailableError,
  RewardTrackingUpstreamRejectionError,
} from '@/modules/reward-tracking-integration/reward-tracking-rest.client';

const BASE_URL = 'http://localhost:3040';
const TOKEN = 'unit-test-token';

function fakeConfig(baseUrl: string | undefined): ConfigService<never, true> {
  return { get: () => baseUrl } as unknown as ConfigService<never, true>;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('T-INT-030 — RewardTrackingRestClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("RewardTrackingGrpcNotAvailableError exists as a class this leg's call site can throw for TC-6 (declared here, next to this leg's other outcomes)", () => {
    const error = new RewardTrackingGrpcNotAvailableError({ logMessage: 'no gRPC surface' });
    expect(error.status).toBe(501);
  });

  it('a 2xx response is returned as parsed JSON, calling the exact campaign-summary path with a Bearer header', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { campaignCode: 'C1', totals: [] }));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new RewardTrackingRestClient(fakeConfig(BASE_URL));
    const result = await client.getCampaignSummary('C1', TOKEN);

    expect(result).toEqual({ campaignCode: 'C1', totals: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/reward-tracking/campaigns/C1/summary`,
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
  });

  it('TC-7: alerts responds with an empty array — returned as-is, never thrown as an error', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { alerts: [] }));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new RewardTrackingRestClient(fakeConfig(BASE_URL));
    const result = await client.getAlerts(TOKEN);

    expect(result).toEqual({ alerts: [] });
  });

  it.each([400, 401, 403, 404])(
    'TC-4: a %i from RTS is forwarded verbatim as RewardTrackingUpstreamRejectionError with the same status',
    async (status) => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(jsonResponse(status, { message: 'rejected upstream' }));
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const client = new RewardTrackingRestClient(fakeConfig(BASE_URL));

      await expect(client.getTenantSummary(1, TOKEN)).rejects.toMatchObject({
        status,
      });
      await expect(client.getTenantSummary(1, TOKEN)).rejects.toBeInstanceOf(
        RewardTrackingUpstreamRejectionError,
      );
    },
  );

  it('a 500 from RTS becomes RewardTrackingServiceUnavailableError (502), not a passthrough rejection', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new RewardTrackingRestClient(fakeConfig(BASE_URL));

    await expect(client.getAlerts(TOKEN)).rejects.toBeInstanceOf(
      RewardTrackingServiceUnavailableError,
    );
  });

  it('a connection failure (fetch throws) becomes RewardTrackingServiceUnavailableError', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new RewardTrackingRestClient(fakeConfig(BASE_URL));

    await expect(client.getAlerts(TOKEN)).rejects.toBeInstanceOf(
      RewardTrackingServiceUnavailableError,
    );
  });

  it('a DOMException TimeoutError becomes RewardTrackingServiceTimeoutError (504)', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new RewardTrackingRestClient(fakeConfig(BASE_URL));

    await expect(client.getAlerts(TOKEN)).rejects.toBeInstanceOf(RewardTrackingServiceTimeoutError);
  });

  it('an unconfigured REWARD_TRACKING_SERVICE_BASE_URL refuses the call with RewardTrackingServiceUnavailableError, never an empty-string fetch', async () => {
    const fetchMock = jest.fn();
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new RewardTrackingRestClient(fakeConfig(undefined));

    await expect(client.getAlerts(TOKEN)).rejects.toBeInstanceOf(
      RewardTrackingServiceUnavailableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a trailing slash on the configured base URL does not produce a double slash', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { alerts: [] }));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new RewardTrackingRestClient(fakeConfig(`${BASE_URL}/`));
    await client.getAlerts(TOKEN);

    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/reward-tracking/alerts`, expect.anything());
  });

  it('a merchant/country/campaign code with reserved URL characters is percent-encoded into the path', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { totals: [] }));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new RewardTrackingRestClient(fakeConfig(BASE_URL));
    await client.getMerchantSummary('MCH/WEIRD CODE', TOKEN);

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/reward-tracking/merchants/${encodeURIComponent('MCH/WEIRD CODE')}/summary`,
      expect.anything(),
    );
  });
});
