/**
 * T-INT-054 — this leg's own primary/transport selector, matching this plan's own configurable-
 * transport standard (`reward-service-integration-plan/ARCHITECTURE.md` §4) as closely as a
 * Postgres-free service can: this app has no DB (`TRANSPORT-CONFIG.md`'s "env-var-backed legs"
 * section), so `RAP_ACTIVITY_TRANSPORT_PRIMARY` (read once at boot by `from-env.ts`, switched via
 * `set-transport-primary.js --service=test-app-tracking-service --leg=rap-activity`) stands in for
 * a DB-backed resolver row — the exact same pattern `rap-progress-client/client.ts`'s
 * `ConfigurableRapProgressClient` already established for this app's sibling RAP integration.
 *
 * Real automatic primary/fallback failover: try the configured primary; if it fails because the
 * *transport itself* was unreachable (or a locally-detected misconfiguration never even attempted a
 * connection), try the other one; only once both have failed does this throw
 * (`RapServiceUnavailableError`) — the one error `routes/activities.ts` catches, exactly as it
 * already catches every other `submitActivity` failure mode today (this integration's own
 * "must never affect this app's own response" contract is unchanged by this task). A request that
 * reaches RAP but is rejected (`RapServiceRequestError` — a real validation/auth problem, not a
 * transport-availability one) is never retried against the other transport: same params, same
 * request, so retrying would just waste a round trip while hiding a real misconfiguration behind an
 * extra layer of "did it fail everywhere" noise — identical reasoning
 * `rap-progress-client/client.ts`'s own header already gives for the identical decision.
 */
import {
  RapServiceTransportNotAvailableError,
  RapServiceUnavailableError,
  RapServiceUnreachableError,
} from './errors';
import type { RapActivitySubmitter, SubmitActivityRequest, SubmitActivityResponse } from './types';

export const RAP_ACTIVITY_TRANSPORTS = ['REST', 'GRPC'] as const;
export type RapActivityTransport = (typeof RAP_ACTIVITY_TRANSPORTS)[number];

export class ConfigurableRapActivityClient implements RapActivitySubmitter {
  constructor(
    private readonly rest: RapActivitySubmitter,
    private readonly grpc: RapActivitySubmitter,
    private readonly transportPrimary: RapActivityTransport,
  ) {}

  async submitActivity(request: SubmitActivityRequest): Promise<SubmitActivityResponse> {
    const [primary, fallback] =
      this.transportPrimary === 'GRPC' ? [this.grpc, this.rest] : [this.rest, this.grpc];

    try {
      return await primary.submitActivity(request);
    } catch (primaryError) {
      if (
        !(primaryError instanceof RapServiceUnreachableError) &&
        !(primaryError instanceof RapServiceTransportNotAvailableError)
      ) {
        throw primaryError;
      }
      console.warn(
        `rap-client: primary transport (${this.transportPrimary}) unreachable, trying the ` +
          `fallback: ${primaryError.message}`,
      );
      try {
        return await fallback.submitActivity(request);
      } catch (fallbackError) {
        throw new RapServiceUnavailableError(primaryError, fallbackError);
      }
    }
  }
}
