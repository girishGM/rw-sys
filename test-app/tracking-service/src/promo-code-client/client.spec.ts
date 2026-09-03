/**
 * Unit tests for `PromoCodeClient`, against an injected fake `fetch` — same style as
 * `portal-client/client.spec.ts`, deterministic and CI-safe (no real promo-code-service needed).
 */
import { PromoCodeClient } from './client';
import { PromoCodeServiceRequestError, PromoCodeServiceUnreachableError } from './errors';
import type { GenerateCodeRequest } from './types';

const GENERATE_URL = 'http://promo.test/api/v1/promo-codes/generate';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function buildClient(fetchImpl: jest.Mock): PromoCodeClient {
  return new PromoCodeClient({
    baseUrl: 'http://promo.test',
    generationToken: 'test-generation-token',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

const REQUEST: GenerateCodeRequest = {
  correlationId: 'a1a1a1a1-0000-4000-8000-000000000001',
  tenantId: '1',
  bindLevel: 'TRACKER',
  bindRefId: '7',
  customerId: 'priya-shah',
};

describe('PromoCodeClient', () => {
  it('POSTs to /api/v1/promo-codes/generate with the bearer token and JSON body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        status: 'SUCCESS',
        promoCodeId: 'pc-1',
        code: 'SAVE20-AB12',
        rewardValueType: 'PERCENT_OFF',
        rewardValue: '20',
        rewardUnit: null,
        expiresAt: null,
        errorCode: null,
        errorMessage: null,
      }),
    );
    const client = buildClient(fetchImpl);

    const result = await client.generateCode(REQUEST);

    expect(result.status).toBe('SUCCESS');
    expect(result.code).toBe('SAVE20-AB12');
    expect(fetchImpl).toHaveBeenCalledWith(
      GENERATE_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-generation-token' }),
        body: JSON.stringify(REQUEST),
      }),
    );
  });

  it('returns a FAILED business outcome as a normal resolved result, not a throw', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        status: 'FAILED',
        promoCodeId: null,
        code: null,
        rewardValueType: null,
        rewardValue: null,
        rewardUnit: null,
        expiresAt: null,
        errorCode: 'CONFIG_NOT_BOUND',
        errorMessage: 'No active binding for tenant "1", bindLevel "TRACKER", bindRefId "7"',
      }),
    );
    const client = buildClient(fetchImpl);

    const result = await client.generateCode(REQUEST);

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CONFIG_NOT_BOUND');
  });

  it('a real HTTP error status throws PromoCodeServiceRequestError', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(401, { message: 'bad token' }));
    const client = buildClient(fetchImpl);

    await expect(client.generateCode(REQUEST)).rejects.toBeInstanceOf(
      PromoCodeServiceRequestError,
    );
  });

  it('a network failure throws PromoCodeServiceUnreachableError, never an unhandled rejection', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = buildClient(fetchImpl);

    await expect(client.generateCode(REQUEST)).rejects.toBeInstanceOf(
      PromoCodeServiceUnreachableError,
    );
  });
});
