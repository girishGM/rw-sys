/**
 * Unit tests for `RapActivityClient`, against an injected fake `RawActivityIngestServiceClient` —
 * same style as `promo-code-client/client.spec.ts`'s injected fake `fetch`, deterministic and
 * CI-safe (no real realtime-activity-processing-service, and no real gRPC channel, needed).
 */
import * as grpc from '@grpc/grpc-js';
import {
  RapActivityClient,
  validateSubmitActivityRequest,
  type RawActivityIngestServiceClient,
} from './client';
import {
  RapServiceRequestError,
  RapServiceUnreachableError,
  RapServiceValidationError,
} from './errors';
import type { SubmitActivityRequest, SubmitActivityResponse } from './types';

const VALID_REQUEST: SubmitActivityRequest = {
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
  activityEventId: 'a1a1a1a1-0000-4000-8000-000000000001',
  correlationId: 'a1a1a1a1-0000-4000-8000-000000000001',
};

function buildClient(rawClient: RawActivityIngestServiceClient): RapActivityClient {
  return new RapActivityClient({ host: 'localhost', port: 50071, timeoutMs: 2500 }, rawClient);
}

function fakeRawClient(
  handler: (
    request: unknown,
    callback: (error: grpc.ServiceError | null, response: SubmitActivityResponse) => void,
  ) => void,
): RawActivityIngestServiceClient {
  return {
    submitActivity: jest.fn((request, _metadata, _options, callback) => handler(request, callback)),
    close: jest.fn(),
  };
}

function grpcError(code: grpc.status, details: string): grpc.ServiceError {
  return Object.assign(new Error(details), { code, details, metadata: new grpc.Metadata() });
}

describe('RapActivityClient.submitActivity', () => {
  it('a successful call resolves with the response RAP returns', async () => {
    const response: SubmitActivityResponse = {
      correlationId: VALID_REQUEST.correlationId ?? '',
      status: 'accepted',
      matchedTrackerComponents: ['COMP_A'],
    };
    const rawClient = fakeRawClient((_request, callback) => callback(null, response));
    const client = buildClient(rawClient);

    const result = await client.submitActivity(VALID_REQUEST);

    expect(result).toEqual(response);
    expect(rawClient.submitActivity).toHaveBeenCalledWith(
      VALID_REQUEST,
      expect.any(grpc.Metadata),
      expect.objectContaining({ deadline: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('RAP unreachable (UNAVAILABLE) rejects with RapServiceUnreachableError, never throws synchronously', async () => {
    const rawClient = fakeRawClient((_request, callback) =>
      callback(
        grpcError(grpc.status.UNAVAILABLE, 'connect ECONNREFUSED 127.0.0.1:50071'),
        undefined as never,
      ),
    );
    const client = buildClient(rawClient);

    await expect(client.submitActivity(VALID_REQUEST)).rejects.toBeInstanceOf(
      RapServiceUnreachableError,
    );
  });

  it('a timeout (DEADLINE_EXCEEDED) also rejects with RapServiceUnreachableError', async () => {
    const rawClient = fakeRawClient((_request, callback) =>
      callback(grpcError(grpc.status.DEADLINE_EXCEEDED, 'Deadline exceeded'), undefined as never),
    );
    const client = buildClient(rawClient);

    await expect(client.submitActivity(VALID_REQUEST)).rejects.toBeInstanceOf(
      RapServiceUnreachableError,
    );
  });

  it('a request RAP reaches but rejects (e.g. PERMISSION_DENIED from MtlsGuard) rejects with RapServiceRequestError', async () => {
    const rawClient = fakeRawClient((_request, callback) =>
      callback(
        grpcError(
          grpc.status.PERMISSION_DENIED,
          'Client certificate identity is not on the allowlist',
        ),
        undefined as never,
      ),
    );
    const client = buildClient(rawClient);

    await expect(client.submitActivity(VALID_REQUEST)).rejects.toBeInstanceOf(
      RapServiceRequestError,
    );
  });

  it('a missing required field is rejected locally as RapServiceValidationError, with no network call', async () => {
    const rawClient = fakeRawClient(() => {
      throw new Error('must not be called — validation should fail first');
    });
    const client = buildClient(rawClient);
    const malformed = { ...VALID_REQUEST, customerId: '' };

    await expect(client.submitActivity(malformed)).rejects.toBeInstanceOf(
      RapServiceValidationError,
    );
    expect(rawClient.submitActivity).not.toHaveBeenCalled();
  });

  it('a request missing both transactionType and activityCode is rejected locally', async () => {
    const rawClient = fakeRawClient(() => {
      throw new Error('must not be called — validation should fail first');
    });
    const client = buildClient(rawClient);
    const malformed = { ...VALID_REQUEST, activityCode: undefined };

    await expect(client.submitActivity(malformed)).rejects.toBeInstanceOf(
      RapServiceValidationError,
    );
    expect(rawClient.submitActivity).not.toHaveBeenCalled();
  });

  it('an activityPerformedDate with no explicit UTC offset is rejected locally', async () => {
    const rawClient = fakeRawClient(() => {
      throw new Error('must not be called — validation should fail first');
    });
    const client = buildClient(rawClient);
    const malformed = { ...VALID_REQUEST, activityPerformedDate: '2026-09-01 10:15:30' };

    await expect(client.submitActivity(malformed)).rejects.toBeInstanceOf(
      RapServiceValidationError,
    );
    expect(rawClient.submitActivity).not.toHaveBeenCalled();
  });
});

describe('validateSubmitActivityRequest', () => {
  it('returns null for a well-formed request', () => {
    expect(validateSubmitActivityRequest(VALID_REQUEST)).toBeNull();
  });

  it('returns a message naming the first missing required field', () => {
    expect(validateSubmitActivityRequest({ ...VALID_REQUEST, activityValueUnit: '' })).toMatch(
      /activityValueUnit is required/,
    );
  });
});
