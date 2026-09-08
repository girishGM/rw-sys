/**
 * T-INT-022 — calls `reward-tracking-service`'s real, RTS-owned
 * `GET /customers/:customerId/rewards/summary` (`customer-rewards.controller.ts`, T-RTS-030),
 * guarded by `CustomerAuthGuard` (T-RTS-032). Pure transport plumbing only, mirroring the split
 * `promo-code-client/client.ts` already established: this class does the call and throws typed
 * errors (`errors.ts`) on failure; it is `client.ts`'s/the route's job, not this file's, to catch
 * those and degrade gracefully.
 */
import { RewardTrackingRequestError, RewardTrackingUnreachableError } from './errors';
import { signCustomerToken } from './token';
import type { CustomerRewardsSummary, GetCustomerRewardsSummaryParams } from './types';

type FetchLike = typeof fetch;

/** Short-lived on purpose — this app mints a fresh token per request rather than caching one, so a
 * leaked/logged token (it never is logged, but defence in depth) is only ever useful for a few
 * seconds. Matches the general shape of a real upstream gateway's own token lifetime, not a
 * specific RTS-side requirement (RTS itself only checks `exp` against "now"). */
const DEFAULT_TOKEN_TTL_SECONDS = 300;

export interface RewardTrackingRestClientConfig {
  /** e.g. `http://localhost:3040` — no trailing slash required, one is stripped if present. */
  readonly baseUrl: string;
  /** Raw HMAC key bytes — see `token.ts`'s `parseCustomerAuthSecret` for how `.env`'s base64
   * encoding gets here. */
  readonly customerAuthSecret: Buffer;
  readonly timeoutMs: number;
  readonly tokenTtlSeconds?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
}

export class RewardTrackingRestClient {
  private readonly baseUrl: string;
  private readonly secret: Buffer;
  private readonly timeoutMs: number;
  private readonly tokenTtlSeconds: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(config: RewardTrackingRestClientConfig) {
    if (config.baseUrl.trim().length === 0) {
      throw new Error('RewardTrackingRestClient: baseUrl is required');
    }
    if (config.customerAuthSecret.length === 0) {
      throw new Error('RewardTrackingRestClient: customerAuthSecret is required');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.secret = config.customerAuthSecret;
    this.timeoutMs = config.timeoutMs;
    this.tokenTtlSeconds = config.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  async getCustomerRewardsSummary(
    params: GetCustomerRewardsSummaryParams,
  ): Promise<CustomerRewardsSummary> {
    const token = signCustomerToken(
      {
        tenantId: params.tenantId,
        customerId: params.customerId,
        exp: Math.floor(this.now().getTime() / 1000) + this.tokenTtlSeconds,
      },
      this.secret,
    );

    const path = `/customers/${encodeURIComponent(params.customerId)}/rewards/summary`;
    const query = params.campaignCode
      ? `?campaignCode=${encodeURIComponent(params.campaignCode)}`
      : '';
    const url = `${this.baseUrl}${path}${query}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new RewardTrackingUnreachableError(this.baseUrl, cause);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new RewardTrackingRequestError(response.status, await readBody(response));
    }
    return (await response.json()) as CustomerRewardsSummary;
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}
