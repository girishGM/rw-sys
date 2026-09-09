/**
 * T-INT-022 — the leg's own primary/transport selector, matching this plan's own configurable-
 * transport standard (`ARCHITECTURE.md` §4) as closely as a Postgres-free service can: this app has
 * no DB (`TRANSPORT-CONFIG.md`'s "env-var-backed legs" section), so `REWARD_TRACKING_TRANSPORT_PRIMARY`
 * (read once at boot by `from-env.ts`, switched via `set-transport-primary.js
 * --service=test-app-tracking-service --leg=rts-rewards`) stands in for a DB-backed resolver row.
 *
 * **There is deliberately no gRPC client here.** `reward-tracking-service` exposes no read-facing
 * gRPC surface today — only its inbound ingest server (`src/grpc/reward-tracking-ingest.grpc-
 * controller.ts`, confirmed by direct read, see this task's completion report). Building a gRPC
 * client against an endpoint that doesn't exist would be dead, untestable code; instead, selecting
 * `GRPC` fails closed with a clear, typed error the very first time it's actually used — never a
 * silent hang, never an attempted connection (TC-4).
 */
import { RewardTrackingTransportNotAvailableError } from './errors';
import type { RewardTrackingRestClient } from './rest.client';
import type { CustomerRewardsSummary, GetCustomerRewardsSummaryParams } from './types';

export const REWARD_TRACKING_TRANSPORTS = ['REST', 'GRPC'] as const;
export type RewardTrackingTransport = (typeof REWARD_TRACKING_TRANSPORTS)[number];

export interface RewardTrackingClient {
  getCustomerRewardsSummary(
    params: GetCustomerRewardsSummaryParams,
  ): Promise<CustomerRewardsSummary>;
}

export class ConfigurableRewardTrackingClient implements RewardTrackingClient {
  constructor(
    private readonly rest: RewardTrackingRestClient,
    private readonly transportPrimary: RewardTrackingTransport,
  ) {}

  async getCustomerRewardsSummary(
    params: GetCustomerRewardsSummaryParams,
  ): Promise<CustomerRewardsSummary> {
    if (this.transportPrimary === 'GRPC') {
      // Fails closed immediately, per this leg's own scope note (a future RTS-side gRPC read
      // surface is a separate, filed task — see this task's completion report) — never attempts a
      // connection, never hangs.
      throw new RewardTrackingTransportNotAvailableError('GRPC');
    }
    return this.rest.getCustomerRewardsSummary(params);
  }
}
