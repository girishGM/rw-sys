/**
 * T-INT-054. Unit tests for `RapActivityRestClient`, against an injected fake `fetch` — same style
 * as `rap-progress-client/rest.client.spec.ts` (deterministic, CI-safe; a real RAP process is
 * exercised manually per this task's own Verification steps/completion report).
 */
import { RapActivityRestClient, validateSubmitActivityRequestForRest } from './rest.client';
import {
  RapServiceRequestError,
  RapServiceUnreachableError,
  RapServiceValidationError,
} from './errors';
import type { SubmitActivityRequest, SubmitActivityResponse } from './types';

const BASE_URL = 'http://rap.test';
const TOKEN = 'a-real-token';

const VALID_REQUEST: SubmitActivityRequest = {
  tenantId: 1,
  customerId: 'priya-shah',
  customerIdType: 'EXTERNAL_ID',
  activityPerformedDate: '2026-09-01T10:15:30Z',
  activityCode: 'Grocery Purchase',
  activityType: 'Grocery Purchase',
  activityCategory: 'GENERAL',
  activityValue: '12.5',
  activityValueUnit: 'USD',
  channel: 'test-app-tracking-service',
  activityPerformedEnv: 'test-app-demo',
  activityName: 'Grocery Purchase',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function buildClient(fetchImpl: jest.Mock): RapActivityRestClient {
  return new RapActivityRestClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    timeoutMs: 2_000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('RapActivityRestClient.submitActivity', () => {
  it('a successful call POSTs to /api/v1/activities with the bearer token and resolves with the response RAP returns', async () => {
    const response: SubmitActivityResponse = {
      correlationId: 'corr-1',
      status: 'accepted',
      matchedTrackerComponents: ['COMP1'],
    };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, response));
    const client = buildClient(fetchImpl);

    const result = await client.submitActivity(VALID_REQUEST);

    expect(result).toEqual(response);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/activities`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      }),
    );
    const [, options] = fetchImpl.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual(VALID_REQUEST);
  });

  it('a network-level failure rejects with RapServiceUnreachableError', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const client = buildClient(fetchImpl);

    await expect(client.submitActivity(VALID_REQUEST)).rejects.toBeInstanceOf(
      RapServiceUnreachableError,
    );
  });

  it('a non-2xx response (e.g. 401 from ActivityIngestRestTokenGuard) rejects with RapServiceRequestError', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(401, { message: 'Unauthorized' }));
    const client = buildClient(fetchImpl);

    await expect(client.submitActivity(VALID_REQUEST)).rejects.toBeInstanceOf(
      RapServiceRequestError,
    );
  });

  it('a 400 (validation rejected by RAP itself) also rejects with RapServiceRequestError', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(400, { message: 'Invalid activity ingest request' }));
    const client = buildClient(fetchImpl);

    await expect(client.submitActivity(VALID_REQUEST)).rejects.toBeInstanceOf(
      RapServiceRequestError,
    );
  });

  it('a missing tenantId is rejected locally as RapServiceValidationError, with no network call', async () => {
    const fetchImpl = jest.fn();
    const client = buildClient(fetchImpl);
    const { tenantId, ...malformed } = VALID_REQUEST;
    void tenantId;

    await expect(client.submitActivity(malformed)).rejects.toBeInstanceOf(
      RapServiceValidationError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a missing required field is rejected locally, with no network call', async () => {
    const fetchImpl = jest.fn();
    const client = buildClient(fetchImpl);
    const malformed = { ...VALID_REQUEST, customerId: '' };

    await expect(client.submitActivity(malformed)).rejects.toBeInstanceOf(
      RapServiceValidationError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('validateSubmitActivityRequestForRest', () => {
  it('returns null for a well-formed request', () => {
    expect(validateSubmitActivityRequestForRest(VALID_REQUEST)).toBeNull();
  });

  it('requires tenantId, unlike the gRPC-only validateSubmitActivityRequest', () => {
    const { tenantId, ...withoutTenantId } = VALID_REQUEST;
    void tenantId;
    expect(validateSubmitActivityRequestForRest(withoutTenantId)).toMatch(/tenantId/);
  });
});
