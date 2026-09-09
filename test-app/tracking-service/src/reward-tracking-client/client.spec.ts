import { ConfigurableRewardTrackingClient } from './client';
import { RewardTrackingTransportNotAvailableError } from './errors';
import type { RewardTrackingRestClient } from './rest.client';

function fakeRest(getCustomerRewardsSummary: jest.Mock): RewardTrackingRestClient {
  return { getCustomerRewardsSummary } as unknown as RewardTrackingRestClient;
}

describe('ConfigurableRewardTrackingClient', () => {
  it('REST primary delegates straight through to the REST client', async () => {
    const summary = { customerId: 'priya-shah', components: [] };
    const getCustomerRewardsSummary = jest.fn().mockResolvedValue(summary);
    const client = new ConfigurableRewardTrackingClient(
      fakeRest(getCustomerRewardsSummary),
      'REST',
    );

    const result = await client.getCustomerRewardsSummary({
      customerId: 'priya-shah',
      tenantId: 1,
    });

    expect(result).toBe(summary);
    expect(getCustomerRewardsSummary).toHaveBeenCalledWith({
      customerId: 'priya-shah',
      tenantId: 1,
    });
  });

  it('TC-4: GRPC primary fails closed with a clear, typed error — never attempts the REST client, never hangs', async () => {
    const getCustomerRewardsSummary = jest.fn();
    const client = new ConfigurableRewardTrackingClient(
      fakeRest(getCustomerRewardsSummary),
      'GRPC',
    );

    await expect(
      client.getCustomerRewardsSummary({ customerId: 'priya-shah', tenantId: 1 }),
    ).rejects.toBeInstanceOf(RewardTrackingTransportNotAvailableError);
    expect(getCustomerRewardsSummary).not.toHaveBeenCalled();
  });
});
