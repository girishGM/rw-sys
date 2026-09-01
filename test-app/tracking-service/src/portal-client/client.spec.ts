/**
 * Unit tests for `PortalClient`, against an injected fake `fetch` — deterministic and CI-safe.
 * The task's own Verification steps (run against a real, running `portal/back-end`) are pasted
 * into the T-003 completion report separately, per AGENT-PROTOCOL.md §4.
 */
import { PortalClient } from './client';
import { PortalAuthError, PortalRequestError, PortalUnreachableError } from './errors';

const LOGIN_URL = 'http://portal.test/api/v1/auth/login';
const JOURNEY_URL = 'http://portal.test/api/v1/campaigns/42/journey';

function jsonResponse(status: number, body: unknown, setCookie: string[] = []): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => setCookie } as unknown as Headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const RAW_CAMPAIGN = {
  id: 1,
  campaignCode: 'SUMMER_CASHBACK_SPRINT',
  name: 'Summer Cashback Sprint',
  description: 'Earn cashback on qualifying purchases.',
  startDate: '2026-07-01',
  endDate: '2026-09-30',
  status: 'active',
};

const RAW_JOURNEY = {
  campaignId: 42,
  trackers: [
    {
      id: 7,
      trackerCode: 'SUMMER_PURCHASE_STREAK',
      name: 'Purchase Streak',
      description: null,
      completionLogic: 'n_of',
      completionThreshold: 5,
      isPrimary: true,
      status: 'active',
      components: [
        {
          id: 101,
          componentCode: 'SUMMER_PURCHASE_1',
          name: 'Qualifying Purchase 1',
          description: null,
          activityId: 5,
          activityName: 'Grocery Purchase',
          sequenceOrder: 1,
          isMandatory: false,
          status: 'active',
        },
      ],
      rewards: [
        {
          id: 900,
          level: 'tracker',
          refId: 7,
          rewardPolicyId: 461,
          rewardPolicyName: 'Signup Cashback',
          rewardId: 1375,
          rewardName: 'Signup Cashback',
          unitType: 'currency',
          unitCode: null,
          amount: null,
          status: 'active',
        },
      ],
    },
  ],
  campaignRewards: [],
};

function buildClient(fetchImpl: jest.Mock): PortalClient {
  return new PortalClient({
    baseUrl: 'http://portal.test',
    loginEmail: 'demo@example.invalid',
    loginPassword: 'irrelevant',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('PortalClient', () => {
  it('TC-1: logs in successfully with no error, capturing the session cookie', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: {} }, ['a=b; HttpOnly']));
    const client = buildClient(fetchImpl);

    await expect(client.login()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(LOGIN_URL, expect.objectContaining({ method: 'POST' }));
  });

  it('TC-2: getCampaigns() returns the real campaign data, mapped from the wire shape', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }, ['a=b']))
      .mockResolvedValueOnce(jsonResponse(200, { data: [RAW_CAMPAIGN] }));
    const client = buildClient(fetchImpl);

    const campaigns = await client.getCampaigns();

    expect(campaigns).toEqual([
      {
        id: 1,
        campaignCode: 'SUMMER_CASHBACK_SPRINT',
        name: 'Summer Cashback Sprint',
        description: 'Earn cashback on qualifying purchases.',
        startDate: '2026-07-01',
        endDate: '2026-09-30',
        status: 'active',
      },
    ]);
  });

  it('TC-3: getCampaignJourney(id) returns the real tracker/component structure', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }, ['a=b']))
      .mockResolvedValueOnce(jsonResponse(200, { data: RAW_JOURNEY }));
    const client = buildClient(fetchImpl);

    const journey = await client.getCampaignJourney(42);

    expect(journey.campaignId).toBe(42);
    expect(journey.trackers).toHaveLength(1);
    expect(journey.trackers[0]).toMatchObject({
      id: 7,
      completionLogic: 'n_of',
      completionThreshold: 5,
    });
    expect(journey.trackers[0].components).toHaveLength(1);
    expect(journey.trackers[0].components[0].id).toBe(101);
    expect(fetchImpl).toHaveBeenLastCalledWith(JOURNEY_URL, expect.anything());
  });

  it('TC-4: a second call within the TTL window does not re-hit the portal', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }, ['a=b']))
      .mockResolvedValueOnce(jsonResponse(200, { data: [RAW_CAMPAIGN] }));
    const client = buildClient(fetchImpl);

    await client.getCampaigns();
    const callCountAfterFirst = fetchImpl.mock.calls.length;
    await client.getCampaigns();

    expect(fetchImpl.mock.calls.length).toBe(callCountAfterFirst);
  });

  it('TC-4b: refresh() forces the next call to bypass the cache', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }, ['a=b']))
      .mockResolvedValueOnce(jsonResponse(200, { data: [RAW_CAMPAIGN] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [RAW_CAMPAIGN] }));
    const client = buildClient(fetchImpl);

    await client.getCampaigns();
    client.refresh();
    await client.getCampaigns();

    expect(fetchImpl).toHaveBeenCalledTimes(3); // login + 2 campaign fetches
  });

  it('TC-5: a 401 mid-session re-authenticates automatically and the original call still succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }, ['a=stale'])) // initial login
      .mockResolvedValueOnce(jsonResponse(401, { message: 'session expired' })) // first attempt
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }, ['a=fresh'])) // re-login
      .mockResolvedValueOnce(jsonResponse(200, { data: [RAW_CAMPAIGN] })); // retried attempt
    const client = buildClient(fetchImpl);

    const campaigns = await client.getCampaigns();

    expect(campaigns).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('TC-5b: two consecutive 401s (not just an expired session) fail loudly rather than looping', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }, ['a=b']))
      .mockResolvedValueOnce(jsonResponse(401, { message: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }, ['a=b2']))
      .mockResolvedValueOnce(jsonResponse(401, { message: 'still denied' }));
    const client = buildClient(fetchImpl);

    await expect(client.getCampaigns()).rejects.toBeInstanceOf(PortalRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('TC-9-adjacent: rejects an unsuccessful login with a distinct, typed error', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(401, { message: 'bad creds' }));
    const client = buildClient(fetchImpl);

    await expect(client.login()).rejects.toBeInstanceOf(PortalAuthError);
  });

  it('TC-10: portal unreachable fails loudly, not a silent empty-data fallback', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = buildClient(fetchImpl);

    await expect(client.getCampaigns()).rejects.toBeInstanceOf(PortalUnreachableError);
  });

  it('TC-10b: unreachable mid-session (after a prior successful login) also fails loudly', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }, ['a=b']))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const client = buildClient(fetchImpl);

    await expect(client.getCampaigns()).rejects.toBeInstanceOf(PortalUnreachableError);
  });

  it('concurrent logins in flight are deduped into a single request', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: {} }, ['a=b']));
    const client = buildClient(fetchImpl);

    await Promise.all([client.login(), client.login(), client.login()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects construction with a clear error when required config is missing', () => {
    expect(
      () =>
        new PortalClient({
          baseUrl: '',
          loginEmail: 'demo@example.invalid',
          loginPassword: 'x',
        }),
    ).toThrow(/baseUrl/);
    expect(
      () => new PortalClient({ baseUrl: 'http://portal.test', loginEmail: '', loginPassword: '' }),
    ).toThrow(/loginEmail/);
  });
});
