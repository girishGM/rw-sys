/**
 * Unit tests for `RapProgressGrpcClient`, against an injected fake `RawProgressQueryServiceClient`
 * — same style as `rap-client/client.spec.ts` (deterministic, CI-safe; a real gRPC channel is
 * exercised manually per this task's Verification steps).
 */
import * as grpc from '@grpc/grpc-js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { RapProgressGrpcClient, type RawProgressQueryServiceClient } from './grpc.client';
import { RapProgressRequestError, RapProgressUnreachableError } from './errors';

const SECRET = Buffer.from('e'.repeat(44), 'base64');

function buildClient(rawClient: RawProgressQueryServiceClient): RapProgressGrpcClient {
  return new RapProgressGrpcClient(
    { host: 'localhost', port: 50071, timeoutMs: 3000, secret: SECRET },
    rawClient,
  );
}

function fakeRawClient(
  handlers: Partial<{
    getCampaignProgress: RawProgressQueryServiceClient['getCampaignProgress'];
    getTrackerProgress: RawProgressQueryServiceClient['getTrackerProgress'];
  }>,
): RawProgressQueryServiceClient {
  return {
    getCampaignProgress: jest.fn(
      handlers.getCampaignProgress ??
        (() => {
          throw new Error('not stubbed');
        }),
    ),
    getTrackerProgress: jest.fn(
      handlers.getTrackerProgress ??
        (() => {
          throw new Error('not stubbed');
        }),
    ),
    close: jest.fn(),
  };
}

function grpcError(code: grpc.status, details: string): grpc.ServiceError {
  return Object.assign(new Error(details), { code, details, metadata: new grpc.Metadata() });
}

function verifyBearerMetadata(metadata: grpc.Metadata, secret: Buffer) {
  const values = metadata.get('authorization');
  expect(values).toHaveLength(1);
  const header = values[0] as string;
  expect(header.startsWith('Bearer ')).toBe(true);
  const token = header.slice('Bearer '.length);
  const [payloadSegment, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(payloadSegment).digest('base64url');
  expect(
    timingSafeEqual(Buffer.from(signature, 'base64url'), Buffer.from(expected, 'base64url')),
  ).toBe(true);
  return JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
}

const CAMPAIGN_PROGRESS_RESPONSE = {
  customerId: 'priya-shah',
  campaignCode: 'SUMMER2026',
  trackers: [
    {
      trackerCode: 'ALL_TRACKER',
      completionLogic: 'all',
      isCompleted: false,
      completedAt: '',
      componentsRequiredCount: 2,
      componentsCompletedCount: 1,
      components: [
        { componentCode: 'COMP_A', currentCount: 1, requiredCount: 1, isCompleted: true },
      ],
    },
  ],
};

describe('RapProgressGrpcClient.getCampaignProgress', () => {
  it('sends a verifiable bearer token in gRPC metadata and translates proto3 empty strings to null', async () => {
    const rawClient = fakeRawClient({
      getCampaignProgress: jest.fn((_request, metadata, _options, callback) => {
        verifyBearerMetadata(metadata, SECRET);
        callback(null, CAMPAIGN_PROGRESS_RESPONSE);
      }),
    });
    const client = buildClient(rawClient);

    const result = await client.getCampaignProgress({
      customerId: 'priya-shah',
      tenantId: 3,
      campaignCode: 'SUMMER2026',
    });

    expect(result.trackers[0].completedAt).toBeNull();
    expect(result.trackers[0].componentsCompletedCount).toBe(1);
  });

  it('UNAVAILABLE rejects with RapProgressUnreachableError', async () => {
    const rawClient = fakeRawClient({
      getCampaignProgress: (_request, _metadata, _options, callback) =>
        callback(grpcError(grpc.status.UNAVAILABLE, 'connect ECONNREFUSED'), undefined as never),
    });
    const client = buildClient(rawClient);

    await expect(
      client.getCampaignProgress({ customerId: 'x', tenantId: 1, campaignCode: 'Y' }),
    ).rejects.toBeInstanceOf(RapProgressUnreachableError);
  });

  it('PERMISSION_DENIED rejects with RapProgressRequestError, not Unreachable', async () => {
    const rawClient = fakeRawClient({
      getCampaignProgress: (_request, _metadata, _options, callback) =>
        callback(
          grpcError(grpc.status.PERMISSION_DENIED, 'Token is not authorized for this customerId'),
          undefined as never,
        ),
    });
    const client = buildClient(rawClient);

    await expect(
      client.getCampaignProgress({ customerId: 'x', tenantId: 1, campaignCode: 'Y' }),
    ).rejects.toBeInstanceOf(RapProgressRequestError);
  });
});

describe('RapProgressGrpcClient.getTrackerProgress', () => {
  it('calls the raw client with the right request shape', async () => {
    const getTrackerProgress = jest.fn((_request, _metadata, _options, callback) =>
      callback(null, {
        customerId: 'priya-shah',
        campaignCode: 'SUMMER2026',
        trackerCode: 'ALL_TRACKER',
        completionLogic: 'all',
        isCompleted: true,
        completedAt: '2026-01-01T00:00:00.000Z',
        componentsRequiredCount: 1,
        componentsCompletedCount: 1,
        components: [],
      }),
    );
    const client = buildClient(fakeRawClient({ getTrackerProgress }));

    const result = await client.getTrackerProgress({
      customerId: 'priya-shah',
      tenantId: 1,
      campaignCode: 'SUMMER2026',
      trackerCode: 'ALL_TRACKER',
    });

    expect(getTrackerProgress).toHaveBeenCalledWith(
      { customerId: 'priya-shah', campaignCode: 'SUMMER2026', trackerCode: 'ALL_TRACKER' },
      expect.any(grpc.Metadata),
      expect.objectContaining({ deadline: expect.any(Number) }),
      expect.any(Function),
    );
    expect(result.isCompleted).toBe(true);
    expect(result.completedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
