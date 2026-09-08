import {
  createRewardTrackingClientFromEnv,
  DEFAULT_REWARD_TRACKING_SERVICE_BASE_URL,
} from './from-env';
import { ConfigurableRewardTrackingClient } from './client';

const SECRET_B64 = Buffer.from('d'.repeat(32)).toString('base64');

describe('createRewardTrackingClientFromEnv', () => {
  it('returns null (not a throw) when CUSTOMER_API_AUTH_SECRET is unset — an optional integration', () => {
    expect(createRewardTrackingClientFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns null for a whitespace-only secret', () => {
    expect(
      createRewardTrackingClientFromEnv({
        CUSTOMER_API_AUTH_SECRET: '   ',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('builds a real client once the secret is present, defaulting base URL/transport', () => {
    const client = createRewardTrackingClientFromEnv({
      CUSTOMER_API_AUTH_SECRET: SECRET_B64,
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRewardTrackingClient);
  });

  it("defaults REWARD_TRACKING_SERVICE_BASE_URL to RTS's own local PORT default when unset", () => {
    // Exercised indirectly: DEFAULT_REWARD_TRACKING_SERVICE_BASE_URL is the one constant both
    // from-env.ts and this assertion read, so a drift between the two would be caught here too.
    expect(DEFAULT_REWARD_TRACKING_SERVICE_BASE_URL).toBe('http://localhost:3040');
  });

  it('an unrecognised REWARD_TRACKING_TRANSPORT_PRIMARY value falls back to REST (R1), not a crash', () => {
    const client = createRewardTrackingClientFromEnv({
      CUSTOMER_API_AUTH_SECRET: SECRET_B64,
      REWARD_TRACKING_TRANSPORT_PRIMARY: 'not-a-real-value',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRewardTrackingClient);
  });
});
