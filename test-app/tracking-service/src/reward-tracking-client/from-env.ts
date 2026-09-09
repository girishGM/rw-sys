/**
 * T-INT-022 — builds a {@link RewardTrackingClient} from `.env` (`REWARD_TRACKING_SERVICE_BASE_URL`/
 * `CUSTOMER_API_AUTH_SECRET`/`REWARD_TRACKING_TRANSPORT_PRIMARY`), or returns `null` when the
 * shared secret is unset.
 *
 * **Defaulting philosophy — closer to `rap-client`'s than to `promo-code-client`'s (see this task's
 * own implementation notes).** This is a *read* path a real page (My Rewards) depends on to render,
 * not a purely optional reward-generation side effect — so `REWARD_TRACKING_SERVICE_BASE_URL`
 * defaults to RTS's own local-dev default (`http://localhost:3040`, its `PORT` default) and
 * `REWARD_TRACKING_TRANSPORT_PRIMARY` defaults to `REST` (this plan's own R1: REST is the default
 * primary everywhere right now). The one thing that genuinely cannot have a safe built-in default is
 * `CUSTOMER_API_AUTH_SECRET` — a real cryptographic secret shared with RTS's own
 * `CustomerAuthGuard`, never invented or committed (R4). Its absence degrades this integration to
 * `null` (the same "optional integration, never breaks boot" contract `promo-code-client` already
 * established) rather than failing loudly the way RTS's own `loadCustomerAuthSecret` does for
 * itself — this is a consumer, not that service's own boot path.
 */
import { ConfigurableRewardTrackingClient, type RewardTrackingClient } from './client';
import { RewardTrackingRestClient } from './rest.client';
import { parseCustomerAuthSecret } from './token';

export const DEFAULT_REWARD_TRACKING_SERVICE_BASE_URL = 'http://localhost:3040';
export const DEFAULT_REWARD_TRACKING_SERVICE_TIMEOUT_MS = 3_000;

export function createRewardTrackingClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RewardTrackingClient | null {
  const secret = parseCustomerAuthSecret(env.CUSTOMER_API_AUTH_SECRET);
  if (!secret) return null;

  const baseUrl =
    env.REWARD_TRACKING_SERVICE_BASE_URL?.trim() || DEFAULT_REWARD_TRACKING_SERVICE_BASE_URL;
  const timeoutMs =
    Number(env.REWARD_TRACKING_SERVICE_TIMEOUT_MS) || DEFAULT_REWARD_TRACKING_SERVICE_TIMEOUT_MS;

  // Unrecognised/unset values fall back to REST — this plan's own R1 default — rather than
  // rejecting boot over a typo in a local `.env` file.
  const transportPrimary =
    env.REWARD_TRACKING_TRANSPORT_PRIMARY?.trim().toUpperCase() === 'GRPC' ? 'GRPC' : 'REST';

  const rest = new RewardTrackingRestClient({ baseUrl, customerAuthSecret: secret, timeoutMs });
  return new ConfigurableRewardTrackingClient(rest, transportPrimary);
}
