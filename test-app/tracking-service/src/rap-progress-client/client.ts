/**
 * T-INT-021 — this leg's own primary/transport selector, matching this plan's own configurable-
 * transport standard (`ARCHITECTURE.md` §4) as closely as a Postgres-free service can: this app
 * has no DB (`TRANSPORT-CONFIG.md`'s "env-var-backed legs" section), so `RAP_PROGRESS_TRANSPORT_
 * PRIMARY` (read once at boot by `from-env.ts`, switched via `set-transport-primary.js
 * --service=test-app-tracking-service --leg=rap-progress`) stands in for a DB-backed resolver row.
 *
 * **Unlike `reward-tracking-client`'s own selector (T-INT-022), a real gRPC surface exists for
 * this leg** (`ProgressQueryService`, T-INT-020) — so this selector does real automatic
 * primary/fallback failover, the same convention RAP's own outbound `campaign-config.client.ts`
 * already established for its identical portal-config leg: try the configured primary; if it
 * fails because the *transport itself* was unreachable, try the other one; only once both have
 * failed does this throw (`RapProgressUnavailableError`), the one error `routes/dashboard.ts`
 * catches to render the "progress unknown" state (Implementation note 4). A request that reaches
 * RAP but is rejected (`RapProgressRequestError` — a real auth/validation problem, not a
 * transport-availability one) is never retried against the other transport — same params, same
 * secret, same likely outcome, so retrying would just waste a round trip while hiding a real
 * misconfiguration behind an extra layer of "did it fail everywhere" noise.
 */
import {
  RapProgressTransportNotAvailableError,
  RapProgressUnavailableError,
  RapProgressUnreachableError,
} from './errors';
import type {
  GetCampaignProgressParams,
  GetTrackerProgressParams,
  RapCampaignProgress,
  RapProgressReader,
  RapTrackerProgress,
} from './types';

export const RAP_PROGRESS_TRANSPORTS = ['REST', 'GRPC'] as const;
export type RapProgressTransport = (typeof RAP_PROGRESS_TRANSPORTS)[number];

export class ConfigurableRapProgressClient implements RapProgressReader {
  constructor(
    private readonly rest: RapProgressReader,
    private readonly grpc: RapProgressReader,
    private readonly transportPrimary: RapProgressTransport,
  ) {}

  async getCampaignProgress(params: GetCampaignProgressParams): Promise<RapCampaignProgress> {
    return this.withFallback((reader) => reader.getCampaignProgress(params));
  }

  async getTrackerProgress(params: GetTrackerProgressParams): Promise<RapTrackerProgress> {
    return this.withFallback((reader) => reader.getTrackerProgress(params));
  }

  private async withFallback<T>(call: (reader: RapProgressReader) => Promise<T>): Promise<T> {
    const [primary, fallback] =
      this.transportPrimary === 'GRPC' ? [this.grpc, this.rest] : [this.rest, this.grpc];

    try {
      return await call(primary);
    } catch (primaryError) {
      // Only a transport-availability failure is worth retrying on the other transport — either
      // a real network-level unreachable, or a locally-detected misconfiguration
      // (`FailClosedProgressReader`, `from-env.ts`) that never even attempted a connection. A
      // reached-but-rejected request (`RapProgressRequestError`) propagates immediately instead —
      // see this file's own header.
      if (
        !(primaryError instanceof RapProgressUnreachableError) &&
        !(primaryError instanceof RapProgressTransportNotAvailableError)
      ) {
        throw primaryError;
      }
      console.warn(
        `rap-progress-client: primary transport (${this.transportPrimary}) unreachable, ` +
          `trying the fallback: ${primaryError.message}`,
      );
      try {
        return await call(fallback);
      } catch (fallbackError) {
        throw new RapProgressUnavailableError(primaryError, fallbackError);
      }
    }
  }
}
