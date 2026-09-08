/**
 * Unit tests for `RewardTrackingRestClient`, against an injected fake `fetch` — same style as
 * `promo-code-client/client.spec.ts`, deterministic and CI-safe (no real reward-tracking-service
 * needed for this file; a real one is exercised manually per this task's Verification steps).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { RewardTrackingRestClient } from './rest.client';
import { RewardTrackingRequestError, RewardTrackingUnreachableError } from './errors';

const SECRET = Buffer.from('c'.repeat(44), 'base64');
const BASE_URL = 'http://rts.test';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function buildClient(fetchImpl: jest.Mock, now?: () => Date): RewardTrackingRestClient {
  return new RewardTrackingRestClient({
    baseUrl: BASE_URL,
    customerAuthSecret: SECRET,
    timeoutMs: 2_000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now,
  });
}

/** Independently decodes the `Authorization` header this client sends — the "assert the observable
 * property, not the implementation string" rule (AGENT-PROTOCOL.md §3): this checks the token is
 * one a real HMAC-SHA256 verifier over `SECRET` would actually accept, not merely that some string
 * was sent. */
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

describe('RewardTrackingRestClient.getCustomerRewardsSummary', () => {
  it('GETs /customers/:id/rewards/summary with a bearer token that verifies against the shared secret and the right claims', async () => {
    const summaryBody = { customerId: 'priya-shah', components: [] };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, summaryBody));
    const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');
    const client = buildClient(fetchImpl, fixedNow);

    const result = await client.getCustomerRewardsSummary({
      customerId: 'priya-shah',
      tenantId: 7,
    });

    expect(result).toEqual(summaryBody);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/customers/priya-shah/rewards/summary`);
    const claims = verifyBearerToken(init.headers.Authorization, SECRET);
    expect(claims.tenantId).toBe(7);
    expect(claims.customerId).toBe('priya-shah');
    expect(claims.exp).toBe(Math.floor(fixedNow().getTime() / 1000) + 300);
  });

  it('appends ?campaignCode= when provided', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { customerId: 'x', components: [] }));
    const client = buildClient(fetchImpl);

    await client.getCustomerRewardsSummary({
      customerId: 'priya-shah',
      tenantId: 1,
      campaignCode: 'SUMMER2026',
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/customers/priya-shah/rewards/summary?campaignCode=SUMMER2026`);
  });

  it('a real HTTP error status throws RewardTrackingRequestError', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(401, { message: 'bad token' }));
    const client = buildClient(fetchImpl);

    await expect(
      client.getCustomerRewardsSummary({ customerId: 'priya-shah', tenantId: 1 }),
    ).rejects.toBeInstanceOf(RewardTrackingRequestError);
  });

  it('a network failure throws RewardTrackingUnreachableError, never an unhandled rejection', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = buildClient(fetchImpl);

    await expect(
      client.getCustomerRewardsSummary({ customerId: 'priya-shah', tenantId: 1 }),
    ).rejects.toBeInstanceOf(RewardTrackingUnreachableError);
  });
});
