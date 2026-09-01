/**
 * T-006 — `apiClient.ts`'s own contract: unwraps `{ data }`, turns any non-2xx into a real
 * `ApiError` carrying the server's message + status (not a generic failure), and builds the
 * right URL (base + path + `?customerId=`) for each endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  getActivities,
  getCampaign,
  getCampaigns,
  getCustomers,
  getDashboard,
  getRewards,
  postActivity,
} from './apiClient';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('apiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getCustomers() unwraps the {data} envelope and hits the right path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'priya-shah' }] }));

    const result = await getCustomers();

    expect(result).toEqual([{ id: 'priya-shah' }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/customers', expect.any(Object));
  });

  it('getDashboard() appends ?customerId=', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { customerId: 'priya-shah' } }));

    await getDashboard('priya-shah');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard?customerId=priya-shah',
      expect.any(Object),
    );
  });

  it('getCampaigns() omits customerId entirely when not given', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await getCampaigns();

    expect(fetchMock).toHaveBeenCalledWith('/api/campaigns', expect.any(Object));
  });

  it('getCampaign() URL-encodes the campaign code and appends customerId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: {} }));

    await getCampaign('SUMMER 25', 'priya-shah');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/campaigns/SUMMER%2025?customerId=priya-shah',
      expect.any(Object),
    );
  });

  it('getRewards() appends customerId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await getRewards('priya-shah');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/rewards?customerId=priya-shah',
      expect.any(Object),
    );
  });

  it('postActivity() POSTs a JSON body to /api/activities', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { activityId: 'abc' } }));

    await postActivity({ customerId: 'priya-shah', activityType: 'purchase' });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/activities');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      customerId: 'priya-shah',
      activityType: 'purchase',
    });
  });

  it('getActivities() appends customerId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await getActivities('priya-shah');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/activities?customerId=priya-shah',
      expect.any(Object),
    );
  });

  it('throws ApiError with the server-provided message on a 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unknown customerId "nope"' }, 404));

    await expect(getDashboard('nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'unknown customerId "nope"',
    });
  });

  it('throws ApiError on a network-level failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));

    await expect(getCustomers()).rejects.toBeInstanceOf(ApiError);
  });

  it('throws ApiError when the response has no "data" key even though it was 2xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oops: true }));

    await expect(getCustomers()).rejects.toThrow('malformed response');
  });
});
