/**
 * Unit tests for `RapProgressRestClient`, against an injected fake `fetch` — same style as
 * `reward-tracking-client/rest.client.spec.ts` (deterministic, CI-safe; a real RAP process is
 * exercised manually per this task's Verification steps).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { RapProgressRestClient } from './rest.client';
import { RapProgressRequestError, RapProgressUnreachableError } from './errors';

const SECRET = Buffer.from('c'.repeat(44), 'base64');
const BASE_URL = 'http://rap.test';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function buildClient(fetchImpl: jest.Mock, now?: () => Date): RapProgressRestClient {
  return new RapProgressRestClient({
    baseUrl: BASE_URL,
    secret: SECRET,
    timeoutMs: 2_000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now,
  });
}

/** Independently decodes the `Authorization` header this client sends — "assert the observable
 * property, not the implementation string" (AGENT-PROTOCOL.md §3). */
function verifyBearerToken(
  authHeader: string,
  secret: Buffer,
): { tenantId: number; customerId: string; exp: number } {
  expect(authHeader.startsWith('Bearer ')).toBe(true);
  const token = authHeader.slice('Bearer '.length);
  const [payloadSegment, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(payloadSegment).digest('base64url');
  expect(
    timingSafeEqual(Buffer.from(signature, 'base64url'), Buffer.from(expected, 'base64url')),
  ).toBe(true);
  return JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
}

const CAMPAIGN_PROGRESS_BODY = {
  customerId: 'priya-shah',
  campaignCode: 'SUMMER2026',
  trackers: [
    {
      trackerCode: 'ALL_TRACKER',
      completionLogic: 'all',
      isCompleted: false,
      completedAt: null,
      componentsRequiredCount: 2,
      componentsCompletedCount: 1,
      components: [
        { componentCode: 'COMP_A', currentCount: 1, requiredCount: 1, isCompleted: true },
        { componentCode: 'COMP_B', currentCount: 0, requiredCount: 1, isCompleted: false },
      ],
    },
  ],
};

describe('RapProgressRestClient.getCampaignProgress', () => {
  it('GETs /progress/customers/:id/campaigns/:code with a bearer token that verifies against the shared secret and the right claims', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, CAMPAIGN_PROGRESS_BODY));
    const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');
    const client = buildClient(fetchImpl, fixedNow);

    const result = await client.getCampaignProgress({
      customerId: 'priya-shah',
      tenantId: 7,
      campaignCode: 'SUMMER2026',
    });

    expect(result).toEqual(CAMPAIGN_PROGRESS_BODY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/progress/customers/priya-shah/campaigns/SUMMER2026`);
    const claims = verifyBearerToken(init.headers.Authorization, SECRET);
    expect(claims.tenantId).toBe(7);
    expect(claims.customerId).toBe('priya-shah');
    expect(claims.exp).toBe(Math.floor(fixedNow().getTime() / 1000) + 300);
  });

  it('a real HTTP error status throws RapProgressRequestError', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(401, { message: 'bad token' }));
    const client = buildClient(fetchImpl);

    await expect(
      client.getCampaignProgress({ customerId: 'priya-shah', tenantId: 1, campaignCode: 'X' }),
    ).rejects.toBeInstanceOf(RapProgressRequestError);
  });

  it('a network failure throws RapProgressUnreachableError, never an unhandled rejection', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = buildClient(fetchImpl);

    await expect(
      client.getCampaignProgress({ customerId: 'priya-shah', tenantId: 1, campaignCode: 'X' }),
    ).rejects.toBeInstanceOf(RapProgressUnreachableError);
  });

  it('translates the empty-string proto3 zero-value convention into null for completionLogic/completedAt', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        customerId: 'priya-shah',
        campaignCode: 'X',
        trackers: [
          {
            trackerCode: 'T1',
            completionLogic: null,
            isCompleted: false,
            completedAt: null,
            componentsRequiredCount: 1,
            componentsCompletedCount: 0,
            components: [],
          },
        ],
      }),
    );
    const client = buildClient(fetchImpl);

    const result = await client.getCampaignProgress({
      customerId: 'priya-shah',
      tenantId: 1,
      campaignCode: 'X',
    });

    expect(result.trackers[0].completionLogic).toBeNull();
    expect(result.trackers[0].completedAt).toBeNull();
  });
});

describe('RapProgressRestClient.getTrackerProgress', () => {
  it('GETs the single-tracker route and returns the unwrapped tracker shape', async () => {
    const body = {
      customerId: 'priya-shah',
      campaignCode: 'SUMMER2026',
      trackerCode: 'ALL_TRACKER',
      completionLogic: 'all',
      isCompleted: false,
      completedAt: null,
      componentsRequiredCount: 2,
      componentsCompletedCount: 1,
      components: [],
    };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, body));
    const client = buildClient(fetchImpl);

    const result = await client.getTrackerProgress({
      customerId: 'priya-shah',
      tenantId: 1,
      campaignCode: 'SUMMER2026',
      trackerCode: 'ALL_TRACKER',
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${BASE_URL}/progress/customers/priya-shah/campaigns/SUMMER2026/trackers/ALL_TRACKER`,
    );
    expect(result.trackerCode).toBe('ALL_TRACKER');
    expect(result.componentsCompletedCount).toBe(1);
  });
});
