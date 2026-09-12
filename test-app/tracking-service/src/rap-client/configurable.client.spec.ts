import { ConfigurableRapActivityClient } from './configurable.client';
import {
  RapServiceRequestError,
  RapServiceTransportNotAvailableError,
  RapServiceUnavailableError,
  RapServiceUnreachableError,
} from './errors';
import type { RapActivitySubmitter, SubmitActivityRequest, SubmitActivityResponse } from './types';

const REQUEST: SubmitActivityRequest = {
  tenantId: 1,
  customerId: 'priya-shah',
  customerIdType: 'EXTERNAL_ID',
  activityPerformedDate: '2026-09-01T10:15:30Z',
  activityCode: 'Grocery Purchase',
  activityType: 'Grocery Purchase',
  activityCategory: 'GENERAL',
  activityValue: '12.5',
  activityValueUnit: 'MYR',
  channel: 'test-app-tracking-service',
  activityPerformedEnv: 'test-app-demo',
  activityName: 'Grocery Purchase',
};

const RESPONSE: SubmitActivityResponse = {
  correlationId: 'corr-1',
  status: 'accepted',
  matchedTrackerComponents: ['COMP1'],
};

function fakeSubmitter(submitActivity: jest.Mock): RapActivitySubmitter {
  return { submitActivity };
}

describe('ConfigurableRapActivityClient', () => {
  it('REST primary, reachable: delegates straight through, never touches gRPC', async () => {
    const rest = fakeSubmitter(jest.fn().mockResolvedValue(RESPONSE));
    const grpc = fakeSubmitter(jest.fn());
    const client = new ConfigurableRapActivityClient(rest, grpc, 'REST');

    const result = await client.submitActivity(REQUEST);

    expect(result).toBe(RESPONSE);
    expect(grpc.submitActivity).not.toHaveBeenCalled();
  });

  it('GRPC primary, reachable: delegates straight through, never touches REST', async () => {
    const rest = fakeSubmitter(jest.fn());
    const grpc = fakeSubmitter(jest.fn().mockResolvedValue(RESPONSE));
    const client = new ConfigurableRapActivityClient(rest, grpc, 'GRPC');

    const result = await client.submitActivity(REQUEST);

    expect(result).toBe(RESPONSE);
    expect(rest.submitActivity).not.toHaveBeenCalled();
  });

  it('primary unreachable automatically falls back to the other transport', async () => {
    const rest = fakeSubmitter(
      jest.fn().mockRejectedValue(new RapServiceUnreachableError('rap.test', new Error())),
    );
    const grpc = fakeSubmitter(jest.fn().mockResolvedValue(RESPONSE));
    const client = new ConfigurableRapActivityClient(rest, grpc, 'REST');

    const result = await client.submitActivity(REQUEST);

    expect(result).toBe(RESPONSE);
    expect(rest.submitActivity).toHaveBeenCalledTimes(1);
    expect(grpc.submitActivity).toHaveBeenCalledTimes(1);
  });

  it('a locally-detected transport-unavailable primary also falls back', async () => {
    const rest = fakeSubmitter(jest.fn().mockResolvedValue(RESPONSE));
    const grpc = fakeSubmitter(
      jest
        .fn()
        .mockRejectedValue(new RapServiceTransportNotAvailableError('GRPC', 'misconfigured')),
    );
    const client = new ConfigurableRapActivityClient(rest, grpc, 'GRPC');

    const result = await client.submitActivity(REQUEST);

    expect(result).toBe(RESPONSE);
  });

  it('both transports unreachable throws RapServiceUnavailableError', async () => {
    const rest = fakeSubmitter(
      jest.fn().mockRejectedValue(new RapServiceUnreachableError('rap.test', new Error())),
    );
    const grpc = fakeSubmitter(
      jest.fn().mockRejectedValue(new RapServiceUnreachableError('rap.test:50071', new Error())),
    );
    const client = new ConfigurableRapActivityClient(rest, grpc, 'REST');

    await expect(client.submitActivity(REQUEST)).rejects.toBeInstanceOf(RapServiceUnavailableError);
  });

  it('a reached-but-rejected request never falls back to the other transport', async () => {
    const rest = fakeSubmitter(
      jest.fn().mockRejectedValue(new RapServiceRequestError(403, 'forbidden')),
    );
    const grpc = fakeSubmitter(jest.fn());
    const client = new ConfigurableRapActivityClient(rest, grpc, 'REST');

    await expect(client.submitActivity(REQUEST)).rejects.toBeInstanceOf(RapServiceRequestError);
    expect(grpc.submitActivity).not.toHaveBeenCalled();
  });

  it('a validation error (e.g. missing tenantId for REST) never falls back either', async () => {
    const rest = fakeSubmitter(jest.fn().mockRejectedValue(new Error('local validation failure')));
    const grpc = fakeSubmitter(jest.fn());
    const client = new ConfigurableRapActivityClient(rest, grpc, 'REST');

    await expect(client.submitActivity(REQUEST)).rejects.toThrow('local validation failure');
    expect(grpc.submitActivity).not.toHaveBeenCalled();
  });
});
