import { ConfigurableRapProgressClient } from './client';
import {
  RapProgressRequestError,
  RapProgressTransportNotAvailableError,
  RapProgressUnavailableError,
  RapProgressUnreachableError,
} from './errors';
import type { RapProgressReader } from './types';

function fakeReader(
  getCampaignProgress: jest.Mock,
  getTrackerProgress: jest.Mock = jest.fn(),
): RapProgressReader {
  return { getCampaignProgress, getTrackerProgress };
}

const PARAMS = { customerId: 'priya-shah', tenantId: 1, campaignCode: 'SUMMER2026' };

describe('ConfigurableRapProgressClient', () => {
  it('REST primary, reachable: delegates straight through, never touches gRPC', async () => {
    const progress = { customerId: 'priya-shah', campaignCode: 'SUMMER2026', trackers: [] };
    const rest = fakeReader(jest.fn().mockResolvedValue(progress));
    const grpc = fakeReader(jest.fn());
    const client = new ConfigurableRapProgressClient(rest, grpc, 'REST');

    const result = await client.getCampaignProgress(PARAMS);

    expect(result).toBe(progress);
    expect(grpc.getCampaignProgress).not.toHaveBeenCalled();
  });

  it('GRPC primary, reachable: delegates straight through, never touches REST', async () => {
    const progress = { customerId: 'priya-shah', campaignCode: 'SUMMER2026', trackers: [] };
    const rest = fakeReader(jest.fn());
    const grpc = fakeReader(jest.fn().mockResolvedValue(progress));
    const client = new ConfigurableRapProgressClient(rest, grpc, 'GRPC');

    const result = await client.getCampaignProgress(PARAMS);

    expect(result).toBe(progress);
    expect(rest.getCampaignProgress).not.toHaveBeenCalled();
  });

  it('TC-5: primary unreachable automatically falls back to the other transport', async () => {
    const progress = { customerId: 'priya-shah', campaignCode: 'SUMMER2026', trackers: [] };
    const rest = fakeReader(
      jest.fn().mockRejectedValue(new RapProgressUnreachableError('REST', 'rap.test', new Error())),
    );
    const grpc = fakeReader(jest.fn().mockResolvedValue(progress));
    const client = new ConfigurableRapProgressClient(rest, grpc, 'REST');

    const result = await client.getCampaignProgress(PARAMS);

    expect(result).toBe(progress);
    expect(rest.getCampaignProgress).toHaveBeenCalledTimes(1);
    expect(grpc.getCampaignProgress).toHaveBeenCalledTimes(1);
  });

  it('a locally-detected transport-unavailable primary also falls back', async () => {
    const progress = { customerId: 'priya-shah', campaignCode: 'SUMMER2026', trackers: [] };
    const rest = fakeReader(jest.fn().mockResolvedValue(progress));
    const grpc = fakeReader(
      jest
        .fn()
        .mockRejectedValue(new RapProgressTransportNotAvailableError('GRPC', 'misconfigured')),
    );
    const client = new ConfigurableRapProgressClient(rest, grpc, 'GRPC');

    const result = await client.getCampaignProgress(PARAMS);

    expect(result).toBe(progress);
  });

  it('TC-3: both transports unreachable throws RapProgressUnavailableError', async () => {
    const rest = fakeReader(
      jest.fn().mockRejectedValue(new RapProgressUnreachableError('REST', 'rap.test', new Error())),
    );
    const grpc = fakeReader(
      jest
        .fn()
        .mockRejectedValue(new RapProgressUnreachableError('GRPC', 'rap.test:50071', new Error())),
    );
    const client = new ConfigurableRapProgressClient(rest, grpc, 'REST');

    await expect(client.getCampaignProgress(PARAMS)).rejects.toBeInstanceOf(
      RapProgressUnavailableError,
    );
  });

  it('a reached-but-rejected request never falls back to the other transport', async () => {
    const rest = fakeReader(
      jest.fn().mockRejectedValue(new RapProgressRequestError('REST', 403, 'forbidden')),
    );
    const grpc = fakeReader(jest.fn());
    const client = new ConfigurableRapProgressClient(rest, grpc, 'REST');

    await expect(client.getCampaignProgress(PARAMS)).rejects.toBeInstanceOf(
      RapProgressRequestError,
    );
    expect(grpc.getCampaignProgress).not.toHaveBeenCalled();
  });

  it('getTrackerProgress applies the identical fallback logic', async () => {
    const trackerProgress = {
      customerId: 'priya-shah',
      campaignCode: 'SUMMER2026',
      trackerCode: 'ALL_TRACKER',
      completionLogic: 'all',
      isCompleted: false,
      completedAt: null,
      componentsRequiredCount: 1,
      componentsCompletedCount: 0,
      components: [],
    };
    const rest = fakeReader(
      jest.fn(),
      jest
        .fn()
        .mockRejectedValueOnce(new RapProgressUnreachableError('REST', 'rap.test', new Error())),
    );
    const grpc = fakeReader(jest.fn(), jest.fn().mockResolvedValue(trackerProgress));
    const client = new ConfigurableRapProgressClient(rest, grpc, 'REST');

    const result = await client.getTrackerProgress({ ...PARAMS, trackerCode: 'ALL_TRACKER' });

    expect(result).toBe(trackerProgress);
  });
});
